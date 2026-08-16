import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { q } from './db.js';
import { syncWallets, snapshotAll, pruneSnapshots } from './sync.js';
import { walletRows, combine, FIELDS, OPS } from './rules.js';

// Resolved against this file, not the working directory, so it doesn't depend on where
// the process was started from.
const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url));

if (!fs.existsSync(`${PUBLIC_DIR}/index.html`)) {
  console.error(`No index.html found in ${PUBLIC_DIR} — the dashboard will 404.`);
  console.error('The file belongs at public/index.html, not the repository root.');
}

const app = express();
const HOSTED = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.FORCE_AUTH);
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';

// A public URL means anyone who finds it can read your wallet list, edit your criteria and
// spend your Helius credits. Refuse to boot rather than serve that unprotected.
if (HOSTED && !PASSWORD) {
  console.error('DASHBOARD_PASSWORD is not set. Add it in the service variables and redeploy.');
  process.exit(1);
}

const safeEqual = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

if (PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const [, encoded] = header.split(' ');
    const [user, pass] = Buffer.from(encoded || '', 'base64').toString().split(':');
    const okUser = safeEqual(user || '', process.env.DASHBOARD_USER || 'admin');
    if (okUser && pass && safeEqual(pass, PASSWORD)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Wallet tracker"').status(401).send('Sign in required.');
  });
}

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const wrap = fn => (req, res) =>
  Promise.resolve(fn(req, res)).catch(e => res.status(500).json({ error: e.message }));

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* ---------- wallets ---------- */

app.get('/api/wallets', (_req, res) => res.json(q.wallets.all()));

app.post('/api/wallets', wrap(async (req, res) => {
  const { address, label, group } = req.body;
  if (!BASE58.test(address || '')) {
    return res.status(400).json({ error: 'That is not a Solana address.' });
  }
  q.addWallet.run(address, label || '', group || '', Date.now());
  // First sync backfills acquisition times from chain, so a new wallet is useful immediately.
  const result = await syncWallets([address], { backfill: true });
  res.json({ wallet: q.wallet.get(address), ...result });
}));

app.patch('/api/wallets/:address', (req, res) => {
  q.editWallet.run(req.body.label || '', req.body.group || '', req.params.address);
  res.json(q.wallet.get(req.params.address));
});

app.delete('/api/wallets/:address', (req, res) => {
  q.delPositions.run(req.params.address);
  q.delSnapshots.run(req.params.address);
  q.delWallet.run(req.params.address);
  res.json({ ok: true });
});

/* ---------- rules ---------- */

app.get('/api/rules', (_req, res) =>
  res.json({ rules: q.rules.all(), fields: FIELDS, ops: OPS }));

app.post('/api/rules', (req, res) => {
  const { scope, target, field, op, value } = req.body;
  if (!FIELDS[field] || !OPS[op]) return res.status(400).json({ error: 'Unknown field or operator.' });
  const info = q.addRule.run(scope, scope === 'global' ? null : target, field, op, String(value), 1);
  res.json({ id: info.lastInsertRowid });
});

app.patch('/api/rules/:id', (req, res) => {
  const { field, op, value, enabled } = req.body;
  q.setRule.run(field, op, String(value), enabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/rules/:id', (req, res) => {
  q.delRule.run(req.params.id);
  res.json({ ok: true });
});

/* ---------- holdings ---------- */

function selected(req) {
  const raw = (req.query.wallets || '').split(',').filter(Boolean);
  const all = q.wallets.all();
  return raw.length ? all.filter(w => raw.includes(w.address)) : all;
}

app.get('/api/holdings', (req, res) => {
  const wallets = selected(req);
  const rules = q.rules.all();

  // Ad-hoc minimum value, applied on top of the saved criteria. Kept out of the rules
  // table on purpose: it's the dial you nudge while looking at the table, not a setting.
  // Tokens Helius has no price for count as 0, so any threshold above 0 hides them.
  const minUsd = Number(req.query.minUsd || 0);
  const perWallet = wallets.map(w =>
    walletRows(w, rules).filter(r => (r.usd_value ?? 0) >= minUsd));

  res.json({
    wallets: wallets.map(w => ({ ...w, matched: perWallet[wallets.indexOf(w)].length })),
    rows: perWallet.flat().sort((a, b) => b.usd_value - a.usd_value),
    combined: combine(perWallet, req.query.mode || 'union', Number(req.query.minWallets || 2)),
    generated_at: Date.now(),
  });
});

/* ---------- refresh (the button) ---------- */

app.post('/api/refresh', wrap(async (req, res) => {
  const addresses = (req.body.wallets?.length ? req.body.wallets : q.wallets.all().map(w => w.address));
  if (!addresses.length) return res.json({ synced: 0, errors: [] });
  // Any mint we've never recorded gets its streak reconstructed from transaction history,
  // so pressing Refresh after a day away still reports the true holding time.
  res.json(await syncWallets(addresses, { backfill: true }));
}));

// Re-derives every position from chain, including ones dated before this existed.
// One history call per open position, so it's a button you press, not a loop.
app.post('/api/rebuild', wrap(async (req, res) => {
  const addresses = (req.body.wallets?.length ? req.body.wallets : q.wallets.all().map(w => w.address));
  if (!addresses.length) return res.json({ synced: 0, errors: [] });
  res.json(await syncWallets(addresses, { rebuild: true }));
}));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Wallet tracker running at http://localhost:${PORT}`));

// Railway allows one volume per service, so on a hosted deploy the snapshotter runs in this
// process instead of as a separate service. Locally, leave SNAPSHOT_MINUTES unset and use
// `npm run snapshot` in a second terminal.
const SNAPSHOT_MINUTES = Number(process.env.SNAPSHOT_MINUTES || 0);
if (SNAPSHOT_MINUTES > 0) {
  const tick = async () => {
    try {
      const { synced, errors } = await snapshotAll();
      pruneSnapshots(30);
      console.log(`snapshotted ${synced} wallets${errors.length ? `, ${errors.length} failed` : ''}`);
    } catch (e) {
      console.error('snapshot failed:', e.message);
    }
  };
  console.log(`Snapshotting every ${SNAPSHOT_MINUTES} min.`);
  setTimeout(tick, 15_000);
  setInterval(tick, SNAPSHOT_MINUTES * 60_000);
}
