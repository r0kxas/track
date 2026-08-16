# Wallet criteria tracker

Local dashboard for Solana wallets: track holdings, filter them by criteria you define
globally or per wallet, and view several wallets together.

## Uploading to GitHub by hand

Create the repo on github.com, then **Add file -> Upload files** and drag in everything
except `node_modules` and `.env`. GitHub's uploader flattens folders, so create the one
nested file separately: **Add file -> Create new file**, type `public/index.html` as the
name (the slash makes the folder), and paste the contents in.

Final layout:

```
README.md
package.json
.gitignore
.env.example
db.js
helius.js
rules.js
server.js
snapshot.js
public/index.html
```

Never commit `.env` — it holds your Helius key. `.gitignore` covers it, but the web
uploader ignores `.gitignore`, so just don't drag that file in.

## Setup (Mac)

```bash
cd ~/Downloads/wallet-tracker     # wherever you put it
npm install
cp .env.example .env
```

Open `.env` and paste your Helius mainnet RPC URL (free tier is fine at this scale):

```
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY_HERE
```

Start it:

```bash
npm start
# -> http://localhost:4000
```

## How holding duration works

Holding time is read from the blockchain, not from how long the tool has been running.

When Refresh meets a mint the database has no record of, it pulls that token account's
parsed transaction history and walks **backwards** from the current balance, subtracting each
transfer, until the balance before some transaction is effectively zero. That transaction
opened the streak the wallet is in right now. The same walk records the largest balance
reached since, which is the real peak behind **left of peak**.

Backwards is the cheap direction. An open position usually resolves in one page of history,
and a wallet that has round-tripped a mint fifty times stops at the last re-entry instead of
replaying everything from the start.

This is what a sold-and-rebought position looks like:

```
90h ago  buy 500      <- token account created here
50h ago  sell 100
20h ago  sell 400     <- balance hits zero, streak ends
 3h ago  buy 600      <- streak start: held for 3h
```

Dating by token-account age would call that 90 hours. It is 3.

**Exits are fuzzy by design.** A sell that leaves dust behind is still an exit, so anything
under 1% of the peak counts as zero when locating a streak start. Without that, a wallet
that dumped 99% of a bag would report a months-long hold on the remainder.

Rows marked **approx** fell back to the token account's creation time because parsed history
wasn't available — accurate for a position never sold, too old for one that was. **Rebuild
history** in the header re-derives every open position from chain, which is what to press
after adding wallets you'd been tracking before this existed.

What still can't be seen: a round trip completed entirely between two refreshes leaves no
row behind, because the position is gone by the time you look. Holding times for what a
wallet *currently* holds are exact regardless of when you last pressed the button.

## Criteria

Fields: `held_hours`, `usd_value`, `amount`, `remaining_pct`, `symbol`, `mint`.
Operators: `≥ ≤ = ≠ contains, is one of, is none of`.

Precedence is **per field**. A global `held_hours ≥ 6` applies everywhere; adding
`held_hours ≥ 24` on one wallet overrides only that field for that wallet — every other
global rule still applies. So you set defaults once and special-case the wallets that need it.

Two global rules ship enabled: `USD value ≥ 50`, and `mint is none of <SOL, USDC, USDT,
mSOL, jitoSOL>` so the table shows what was actually bought rather than quote assets.
Both are editable or deletable in the UI like any other criterion.

## Minimum value

The sidebar has a **$ minimum** box with Off / $50 / $250 / $1k shortcuts. It applies on top
of the saved criteria and isn't stored — it's the dial you nudge while reading the table.

Anything Helius has no price for counts as $0, so a threshold above zero also hides brand-new
mints with no pool depth yet. Leave it at Off when you're watching fresh launches.

For a threshold that should stick — "this wallet is only interesting above $500" — add
`USD value ≥ 500` as a criterion instead. Same effect, saved, and overridable per wallet.

## Combined view

- **Any selected wallet holds it** — union.
- **All selected wallets hold it** — intersection.
- **At least N wallets hold it** — the one worth watching; N wallets accumulating the same
  mint inside your criteria window is the signal this tool exists to surface.

Held-for in this view shows the **newest** entry among holders, so you can spot a cluster
that all entered recently.

## Hosting on Railway

Two things differ from local:

1. **A volume is mandatory.** SQLite is a file, and Railway wipes the container filesystem on
   every deploy. Without a volume, every holding streak resets to zero each time you push.
   `db.js` reads `RAILWAY_VOLUME_MOUNT_PATH` automatically, so mounting one is all it takes.
2. **A password is mandatory.** The URL is public. The server exits on boot if
   `DASHBOARD_PASSWORD` is missing rather than exposing your wallet list and Helius credits.

`SNAPSHOT_MINUTES` is optional and off by default — set it only if you want timed checks in
the hosted process (Railway allows one volume per service, so a separate snapshot service
can't reach the same database). Left unset, the app only calls Helius when you press Refresh.
Don't set `PORT`; Railway assigns it.

Variables to add in the service:

```
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY_HERE
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=<something long>
CONCURRENCY=4
```

If the deploy logs show a permissions error writing to the volume, add `RAILWAY_RUN_UID=0` —
volumes mount as root and Nixpacks may run your app as a different user.

Cost note: the container stays up so the URL answers, but with `SNAPSHOT_MINUTES` unset it
makes no Helius calls until you press Refresh. Hosting buys you phone access, nothing else.

## Files

| File | Role |
|---|---|
| `db.js` | SQLite schema, prepared statements |
| `helius.js` | RPC: `searchAssets` for balances, parsed history for streak reconstruction |
| `sync.js` | Fetch → snapshot → streak maintenance |
| `rules.js` | Criteria resolution + evaluation, combined view |
| `server.js` | JSON API and static host |
| `snapshot.js` | Optional timed checks |
| `public/index.html` | Dashboard |

## Rate limits

Helius free tier is ~10 requests/second. Each refresh is one call per wallet, so 100 wallets
is fine. Adding a wallet is heavier — one extra call per token held — so it runs once, on add.
If you see 429s, lower `CONCURRENCY` in `.env`.
