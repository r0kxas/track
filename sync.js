import { db, q } from './db.js';
import { fetchHoldings, firstTouchedAt, reconstructPosition } from './helius.js';

const CONCURRENCY = Number(process.env.CONCURRENCY || 4);

// Each undated position costs a history call, and a hosted proxy will cut the request off
// long before a wallet holding hundreds of tokens finishes. Cap the work per pass; the
// remainder is dated on the next refresh, so repeated presses converge on a fully dated set.
const MAX_DATED_PER_SYNC = Number(process.env.MAX_DATED_PER_SYNC || 20);

/**
 * Derive a position's real history from chain: when the current streak started and the
 * true peak since. Falls back to the token account's creation time if the parsed history
 * is unavailable, which is marked estimated so the UI can flag it.
 */
async function fromChain(h, owner) {
  try {
    const exact = await reconstructPosition({ ata: h.ata, mint: h.mint, owner, amount: h.amount });
    if (exact) return { ...exact, estimated: 0 };
  } catch { /* fall through to the cheap approximation */ }

  const created = await firstTouchedAt(h.ata);
  return created
    ? { held_since: created, peak_amount: h.amount, estimated: 1 }
    : null;
}

/**
 * Refresh one wallet: fetch balances, record a snapshot, and maintain each position.
 *
 * Holding time comes from chain, not from how long this has been running. A mint the
 * database has never recorded gets its streak reconstructed from transaction history, so
 * a wallet that bought eight hours before you first pressed Refresh reads as eight hours.
 * Once recorded, the start time stays put — a rebuy after a full exit starts a new streak.
 */
export async function syncWallet(address, { backfill = true, rebuild = false } = {}) {
  const now = Date.now();
  const holdings = await fetchHoldings(address);
  const seen = new Set();
  let dated = 0;

  // Build every row first, then spend the dating budget on the rows that need it most.
  // estimated: 0 = exact from parsed history, 1 = approximated from token-account age,
  // 2 = never dated, still showing a placeholder.
  const rows = holdings.map(h => {
    const prev = q.position.get(address, h.mint);
    const holding = prev && prev.amount > 0 && prev.held_since;
    return {
      h,
      prev,
      held_since: holding ? prev.held_since : now,
      estimated: holding ? prev.estimated : 2,
      peak_amount: Math.max(h.amount, holding ? (prev.peak_amount ?? 0) : 0),
    };
  });

  // Undated rows first, then approximations. Without this ordering a wallet holding more
  // tokens than the cap would keep re-dating the same ones and never reach the rest.
  const queue = rows
    .filter(r => rebuild || r.estimated >= 1)
    .sort((a, b) => b.estimated - a.estimated);

  for (const row of queue) {
    if (dated >= MAX_DATED_PER_SYNC) break;
    const chain = await fromChain(row.h, address);
    if (chain) {
      row.held_since = chain.held_since;
      row.estimated = chain.estimated;
      row.peak_amount = Math.max(chain.peak_amount, row.h.amount);
      dated++;
    }
  }

  for (const row of rows) {
    const { h, prev } = row;
    seen.add(h.mint);
    q.upsertPos.run({
      wallet: address,
      mint: h.mint,
      symbol: h.symbol,
      name: h.name,
      decimals: h.decimals,
      amount: h.amount,
      usd: h.usd,
      ata: h.ata,
      first_seen: prev?.first_seen ?? row.held_since,
      held_since: row.held_since,
      estimated: row.estimated,
      peak_amount: row.peak_amount,
      last_seen: now,
    });
    q.addSnapshot.run(address, h.mint, h.amount, h.usd, now);
  }

  // Anything we tracked that's gone from the response has been fully sold.
  for (const p of q.positions.all(address)) {
    if (!seen.has(p.mint)) {
      q.zeroPos.run(now, address, p.mint);
      q.addSnapshot.run(address, p.mint, 0, 0, now);
    }
  }

  q.touchWallet.run(now, address);
  const pending = rows.filter(r => r.estimated >= 1).length;
  return { positions: holdings.length, dated, pending };
}

/** Refresh several wallets with a small parallel pool. Never throws — failures come back as errors[]. */
export async function syncWallets(addresses, opts = {}) {
  const queue = [...addresses];
  const errors = [];
  let dated = 0, pending = 0;

  const worker = async () => {
    while (queue.length) {
      const address = queue.shift();
      try {
        const r = await syncWallet(address, opts);
        dated += r.dated;
        pending += r.pending;
      } catch (e) {
        console.error(`sync failed for ${address}: ${e.message}`);
        errors.push({ address, message: e.message });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, addresses.length) }, worker));
  return { synced: addresses.length - errors.length, dated, pending, errors };
}

/** Optional timed pass. See README: you only need this to catch round trips. */
export async function snapshotAll() {
  const addresses = q.wallets.all().map(w => w.address);
  if (!addresses.length) return { synced: 0, dated: 0, pending: 0, errors: [] };
  return syncWallets(addresses, { backfill: true });
}

export function pruneSnapshots(days = 30) {
  db.prepare('DELETE FROM snapshots WHERE ts < ?').run(Date.now() - days * 864e5);
}
