import 'dotenv/config';
import { snapshotAll, pruneSnapshots } from './sync.js';

/**
 * The dashboard only updates when you press Refresh, but holding streaks are only as
 * precise as how often the balances get checked. This keeps writing snapshots in the
 * background so "held for 6h" means six hours, not "six hours since I last clicked".
 * Run it in a second terminal: node snapshot.js
 */
const MINUTES = Number(process.argv[2] || 10);

async function tick() {
  const { synced, errors } = await snapshotAll();
  pruneSnapshots(30);
  const stamp = new Date().toLocaleTimeString();
  console.log(`[${stamp}] snapshotted ${synced} wallets${errors.length ? `, ${errors.length} failed` : ''}`);
  for (const e of errors) console.log(`   ${e.address}: ${e.message}`);
}

console.log(`Snapshotting every ${MINUTES} min. Ctrl+C to stop.`);
await tick();
setInterval(tick, MINUTES * 60_000);
