import { db, q } from './db.js';
import { fetchHoldings, firstTouchedAt, reconstructPosition } from './helius.js';

const CONCURRENCY = Number(process.env.CONCURRENCY || 4);

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

  for (const h of holdings) {
    seen.add(h.mint);
    const prev = q.position.get(address, h.mint);
    const holding = prev && prev.amount > 0 && prev.held_since;

    let held_since = holding ? prev.held_since : now;
    let estimated = holding ? prev.estimated : 0;
    let peak_amount = Math.max(h.amount, holding ? (prev.peak_amount ?? 0) : 0);

    // Rebuild re-derives everything; otherwise only mints we have no record of.
    if (rebuild || (!prev && backfill)) {
      const chain = await fromChain(h, address);
      if (chain) {
        held_since = chain.held_since;
        estimated = chain.estimated;
        peak_amount = Math.max(chain.peak_amount, h.amount);
        dated++;
      }
    }

    q.upsertPos.run({
      wallet: address,
      mint: h.mint,
      symbol: h.symbol,
      name: h.name,
      decimals: h.decimals,
      amount: h.amount,
      usd: h.usd,
      ata: h.ata,
      first_seen: prev?.first_seen ?? held_since,
      held_since,
      estimated,
      peak_amount,
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
  return { positions: holdings.length, dated };
}

/** Refresh several wallets with a small parallel pool. Never throws — failures come back as errors[]. */
export async function syncWallets(addresses, opts = {}) {
  const queue = [...addresses];
  const errors = [];
  let dated = 0;

  const worker = async () => {
    while (queue.length) {
      const address = queue.shift();
      try {
        dated += (await syncWallet(address, opts)).dated;
      } catch (e) {
        console.error(`sync failed for ${address}: ${e.message}`);
        errors.push({ address, message: e.message });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, addresses.length) }, worker));
  return { synced: addresses.length - errors.length, dated, errors };
}

/** Optional timed pass. See README: you only need this to catch round trips. */
export async function snapshotAll() {
  const addresses = q.wallets.all().map(w => w.address);
  if (!addresses.length) return { synced: 0, dated: 0, errors: [] };
  return syncWallets(addresses, { backfill: true });
}

export function pruneSnapshots(days = 30) {
  db.prepare('DELETE FROM snapshots WHERE ts < ?').run(Date.now() - days * 864e5);
}
