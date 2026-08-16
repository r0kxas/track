import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// Locally this is ./tracker.db. On Railway, RAILWAY_VOLUME_MOUNT_PATH is set automatically
// when a volume is attached — without one, the container filesystem is wiped on every
// deploy and every holding streak resets to zero.
const DB_PATH = process.env.DB_PATH
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'tracker.db')
      : 'tracker.db');

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
console.log(`Database: ${DB_PATH}`);

db.exec(`
CREATE TABLE IF NOT EXISTS wallets (
  address     TEXT PRIMARY KEY,
  label       TEXT,
  grp         TEXT,
  added_at    INTEGER NOT NULL,
  last_synced INTEGER
);

CREATE TABLE IF NOT EXISTS positions (
  wallet      TEXT NOT NULL,
  mint        TEXT NOT NULL,
  symbol      TEXT,
  name        TEXT,
  decimals    INTEGER,
  amount      REAL NOT NULL,
  usd         REAL,
  ata         TEXT,
  first_seen  INTEGER,        -- first time we ever saw this wallet hold this mint
  held_since  INTEGER,        -- start of the CURRENT unbroken holding streak (null = not holding)
  estimated   INTEGER DEFAULT 0, -- 1 = held_since came from chain backfill, not our own snapshots
  peak_amount REAL,           -- largest amount seen during the current streak
  last_seen   INTEGER,
  PRIMARY KEY (wallet, mint)
);

CREATE TABLE IF NOT EXISTS snapshots (
  wallet TEXT NOT NULL,
  mint   TEXT NOT NULL,
  amount REAL NOT NULL,
  usd    REAL,
  ts     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap ON snapshots (wallet, mint, ts);

CREATE TABLE IF NOT EXISTS rules (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  scope   TEXT NOT NULL,     -- 'global' | 'group' | 'wallet'
  target  TEXT,              -- group name or wallet address; null for global
  field   TEXT NOT NULL,
  op      TEXT NOT NULL,
  value   TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
`);

// Seed one sensible global rule the first time: ignore SOL and the usual quote assets,
// so the table only shows things you actually bought.
const QUOTES = [
  'So11111111111111111111111111111111111111112',  // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
].join(',');

if (db.prepare('SELECT COUNT(*) c FROM rules').get().c === 0) {
  const seed = db.prepare(
    `INSERT INTO rules (scope, target, field, op, value, enabled) VALUES ('global', NULL, ?, ?, ?, 1)`
  );
  seed.run('mint', 'not_in', QUOTES);
  seed.run('usd_value', 'gte', '50');
}

export const q = {
  wallets:      db.prepare('SELECT * FROM wallets ORDER BY label, address'),
  wallet:       db.prepare('SELECT * FROM wallets WHERE address = ?'),
  addWallet:    db.prepare('INSERT OR IGNORE INTO wallets (address,label,grp,added_at) VALUES (?,?,?,?)'),
  editWallet:   db.prepare('UPDATE wallets SET label = ?, grp = ? WHERE address = ?'),
  delWallet:    db.prepare('DELETE FROM wallets WHERE address = ?'),
  delPositions: db.prepare('DELETE FROM positions WHERE wallet = ?'),
  delSnapshots: db.prepare('DELETE FROM snapshots WHERE wallet = ?'),
  touchWallet:  db.prepare('UPDATE wallets SET last_synced = ? WHERE address = ?'),

  positions:    db.prepare('SELECT * FROM positions WHERE wallet = ? AND amount > 0'),
  position:     db.prepare('SELECT * FROM positions WHERE wallet = ? AND mint = ?'),
  upsertPos:    db.prepare(`
    INSERT INTO positions
      (wallet,mint,symbol,name,decimals,amount,usd,ata,first_seen,held_since,estimated,peak_amount,last_seen)
    VALUES
      (@wallet,@mint,@symbol,@name,@decimals,@amount,@usd,@ata,@first_seen,@held_since,@estimated,@peak_amount,@last_seen)
    ON CONFLICT(wallet,mint) DO UPDATE SET
      symbol=@symbol, name=@name, decimals=@decimals, amount=@amount, usd=@usd, ata=@ata,
      held_since=@held_since, estimated=@estimated, peak_amount=@peak_amount, last_seen=@last_seen`),
  zeroPos:      db.prepare('UPDATE positions SET amount = 0, usd = 0, held_since = NULL, peak_amount = 0, last_seen = ? WHERE wallet = ? AND mint = ?'),
  addSnapshot:  db.prepare('INSERT INTO snapshots (wallet,mint,amount,usd,ts) VALUES (?,?,?,?,?)'),

  rules:        db.prepare('SELECT * FROM rules ORDER BY scope, target, field'),
  addRule:      db.prepare('INSERT INTO rules (scope,target,field,op,value,enabled) VALUES (?,?,?,?,?,?)'),
  setRule:      db.prepare('UPDATE rules SET field=?, op=?, value=?, enabled=? WHERE id=?'),
  delRule:      db.prepare('DELETE FROM rules WHERE id = ?'),
};
