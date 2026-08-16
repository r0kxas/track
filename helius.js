import 'dotenv/config';

const RPC = process.env.HELIUS_RPC_URL;
if (!RPC || RPC.includes('YOUR_KEY_HERE')) {
  console.error('Set HELIUS_RPC_URL in .env first.');
  process.exit(1);
}

async function rpc(method, params, attempt = 0) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'wt', method, params }),
  });

  // Free tier rate-limits at 10 rps; back off instead of dropping the wallet.
  if (res.status === 429 && attempt < 4) {
    await new Promise(r => setTimeout(r, 400 * 2 ** attempt));
    return rpc(method, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`${method} failed: HTTP ${res.status}`);

  const json = await res.json();
  if (json.error) throw new Error(`${method} failed: ${json.error.message}`);
  return json.result;
}

/** Every fungible token the wallet currently holds, with USD value where Helius has a price. */
export async function fetchHoldings(owner) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const r = await rpc('searchAssets', {
      ownerAddress: owner,
      tokenType: 'fungible',
      page,
      limit: 1000,
    });
    const items = r?.items ?? [];

    for (const a of items) {
      const ti = a.token_info ?? {};
      const decimals = ti.decimals ?? 0;
      const amount = Number(ti.balance ?? 0) / 10 ** decimals;
      if (!(amount > 0)) continue;

      const perToken = ti.price_info?.price_per_token ?? null;
      out.push({
        mint: a.id,
        symbol: ti.symbol || a.content?.metadata?.symbol || a.id.slice(0, 4),
        name: a.content?.metadata?.name || '',
        decimals,
        amount,
        usd: ti.price_info?.total_price ?? (perToken != null ? perToken * amount : null),
        ata: ti.associated_token_address ?? null,
      });
    }
    if (items.length < 1000) break;
  }
  return out;
}

/**
 * Best-effort acquisition time for a position we've never snapshotted: the oldest
 * signature on the token account, which is normally the transaction that created it.
 * Only used as a fallback now — reconstructPosition() below is exact.
 */
export async function firstTouchedAt(ata) {
  if (!ata) return null;
  let before, oldest = null;

  for (let i = 0; i < 5; i++) {
    const opts = { limit: 1000 };
    if (before) opts.before = before;
    const sigs = await rpc('getSignaturesForAddress', [ata, opts]);
    if (!sigs?.length) break;
    oldest = sigs[sigs.length - 1];
    if (sigs.length < 1000) break;
    before = oldest.signature;
  }
  return oldest?.blockTime ? oldest.blockTime * 1000 : null;
}

/* ------------------------------------------------------------------ *
 * Exact position history
 * ------------------------------------------------------------------ */

// The enhanced REST API takes the key as a query param, so pull it off the RPC URL
// rather than making you configure it twice.
const API_KEY = new URL(RPC).searchParams.get('api-key');
const ENHANCED = 'https://api-mainnet.helius-rpc.com/v0';

// A sell that leaves a few dust tokens behind is still an exit. Anything under 1% of the
// position's peak counts as zero when locating where the current streak started —
// otherwise a wallet that dumped 99% would show a months-long hold on the remainder.
const DUST_PCT = 0.01;

async function parsedHistory(address, beforeSignature) {
  const url = new URL(`${ENHANCED}/addresses/${address}/transactions`);
  url.searchParams.set('api-key', API_KEY);
  url.searchParams.set('limit', '100');
  if (beforeSignature) url.searchParams.set('before-signature', beforeSignature);

  const res = await fetch(url);
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 800));
    return parsedHistory(address, beforeSignature);
  }
  if (!res.ok) throw new Error(`enhanced history failed: HTTP ${res.status}`);
  return res.json();
}

/** Net change in this mint for this token account, in UI units. */
function delta(tx, mint, ata, owner) {
  let net = 0;
  for (const t of tx.tokenTransfers ?? []) {
    if (t.mint !== mint) continue;
    const amount = Number(t.tokenAmount ?? 0);
    const isIn  = t.toTokenAccount === ata   || (!t.toTokenAccount   && t.toUserAccount === owner);
    const isOut = t.fromTokenAccount === ata || (!t.fromTokenAccount && t.fromUserAccount === owner);
    if (isIn)  net += amount;
    if (isOut) net -= amount;
  }
  return net;
}

/**
 * Walk the token account's history backwards from the current balance until the balance
 * before a transaction is effectively zero — that transaction opened the streak the wallet
 * is in right now. Returns the exact start time and the true peak reached since.
 *
 * Backwards is the cheap direction: an open position usually needs one page of history,
 * and a wallet that has round-tripped a mint fifty times stops at the last re-entry
 * instead of replaying everything from the beginning.
 */
export async function reconstructPosition({ ata, mint, owner, amount }) {
  if (!API_KEY || !ata) return null;

  let balance = amount;
  let peak = amount;
  let before;
  let oldestSeen = null;

  for (let page = 0; page < 10; page++) {
    const txs = await parsedHistory(ata, before);
    if (!Array.isArray(txs) || txs.length === 0) break;

    for (const tx of txs) {                      // newest first
      const change = delta(tx, mint, ata, owner);
      const balanceBefore = balance - change;
      peak = Math.max(peak, balance);
      oldestSeen = tx.timestamp;

      if (balanceBefore <= peak * DUST_PCT) {
        return { held_since: tx.timestamp * 1000, peak_amount: peak, exact: true };
      }
      balance = balanceBefore;
    }

    const last = txs[txs.length - 1].signature;
    if (last === before) break;                  // pagination stopped advancing
    before = last;
    if (txs.length < 100) break;
  }

  // History exhausted without the balance ever reaching zero: the position has been open
  // since the oldest transaction we could see.
  return oldestSeen
    ? { held_since: oldestSeen * 1000, peak_amount: peak, exact: true }
    : null;
}
