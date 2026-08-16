import { q } from './db.js';

export const FIELDS = {
  held_hours:    { label: 'Hours held',        type: 'number' },
  usd_value:     { label: 'USD value',         type: 'number' },
  amount:        { label: 'Token amount',      type: 'number' },
  remaining_pct: { label: '% of peak left',    type: 'number' },
  symbol:        { label: 'Symbol',            type: 'text'   },
  mint:          { label: 'Mint',              type: 'text'   },
};

export const OPS = {
  gte:      '≥',
  lte:      '≤',
  eq:       '=',
  neq:      '≠',
  contains: 'contains',
  in:       'is one of',
  not_in:   'is none of',
};

/** Derived values the rules run against. */
export function enrich(p, now = Date.now()) {
  const held_hours = p.held_since ? (now - p.held_since) / 3.6e6 : 0;
  const peak = p.peak_amount || p.amount;
  return {
    ...p,
    held_hours,
    usd_value: p.usd ?? 0,
    remaining_pct: peak > 0 ? (p.amount / peak) * 100 : 100,
  };
}

/**
 * Precedence is per field: a wallet rule on `held_hours` replaces the global one,
 * every other field keeps inheriting. That's what makes "global defaults, custom
 * per wallet" work without re-declaring the whole set on each wallet.
 */
export function resolveRules(wallet, allRules = q.rules.all()) {
  const byField = new Map();
  const rank = { global: 0, group: 1, wallet: 2 };

  for (const r of allRules) {
    if (!r.enabled) continue;
    if (r.scope === 'group'  && r.target !== wallet.grp)      continue;
    if (r.scope === 'wallet' && r.target !== wallet.address)  continue;

    const current = byField.get(r.field);
    if (!current || rank[r.scope] >= rank[current.scope]) byField.set(r.field, r);
  }
  return [...byField.values()];
}

function test(value, op, raw) {
  const list = () => String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const str = String(value ?? '').toLowerCase();

  switch (op) {
    case 'gte':      return Number(value) >= Number(raw);
    case 'lte':      return Number(value) <= Number(raw);
    case 'eq':       return str === String(raw).toLowerCase();
    case 'neq':      return str !== String(raw).toLowerCase();
    case 'contains': return str.includes(String(raw).toLowerCase());
    case 'in':       return list().includes(str);
    case 'not_in':   return !list().includes(str);
    default:         return true;
  }
}

export const passes = (pos, rules) => rules.every(r => test(pos[r.field], r.op, r.value));

/** Filtered, enriched positions for one wallet. */
export function walletRows(wallet, allRules) {
  const rules = resolveRules(wallet, allRules);
  return q.positions.all(wallet.address)
    .map(p => enrich(p))
    .filter(p => passes(p, rules))
    .map(p => ({ ...p, wallet_label: wallet.label || wallet.address.slice(0, 4) }));
}

/**
 * Combined view across selected wallets.
 * mode: 'union' (any wallet), 'intersection' (all of them), 'min' (at least minWallets).
 */
export function combine(rowsByWallet, mode = 'union', minWallets = 2) {
  const selectedCount = rowsByWallet.length;
  const byMint = new Map();

  for (const rows of rowsByWallet) {
    for (const r of rows) {
      const entry = byMint.get(r.mint) ?? {
        mint: r.mint, symbol: r.symbol, name: r.name,
        holders: [], amount: 0, usd_value: 0,
      };
      entry.holders.push({
        wallet: r.wallet, label: r.wallet_label,
        amount: r.amount, usd_value: r.usd_value,
        held_hours: r.held_hours, remaining_pct: r.remaining_pct,
        estimated: r.estimated,
      });
      entry.amount += r.amount;
      entry.usd_value += r.usd_value;
      byMint.set(r.mint, entry);
    }
  }

  const threshold = mode === 'intersection' ? selectedCount : mode === 'min' ? minWallets : 1;

  return [...byMint.values()]
    .filter(e => e.holders.length >= threshold)
    .map(e => ({
      ...e,
      holder_count: e.holders.length,
      held_hours_min: Math.min(...e.holders.map(h => h.held_hours)),
      held_hours_max: Math.max(...e.holders.map(h => h.held_hours)),
    }))
    .sort((a, b) => b.holder_count - a.holder_count || b.usd_value - a.usd_value);
}
