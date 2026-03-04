# CryptoSignal

A crypto monitoring dashboard with real-time trending tokens, smart wallet tracking (Phase 2), and automated paper copy-trading on Solana (Phase 3).

---

## Features

| Phase | Feature |
|-------|---------|
| 1 | Trending tokens across SOL, ETH, BSC, Base — with Grok AI analysis |
| 2 | Smart wallet leaderboard, early-buyer detection, win-rate tracking |
| 3 | Paper copy-trading engine — simulates trades when tracked wallets buy on Solana |

---

## Running Locally

### Prerequisites
- Node.js 18+ (`node -v`)
- npm 9+

### 1. Start the backend server

```bash
cd server
npm install
npm start
```

Server runs at **http://localhost:3001**.

### 2. Open the frontend

Open `index.html` directly in your browser, **or** let the Express server serve it:

```
http://localhost:3001
```

### 3. Add wallets to track

1. Open the app → click **Smart Wallets** tab
2. Paste a Solana wallet address and click **+ Track**
3. Switch to **Paper Trading** tab — trades will auto-open within 15s when the wallet makes a buy

### Environment variables (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Port for the Express server |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Custom Solana RPC endpoint |

Create a `.env` file in `/server` or set them in your deployment platform.

---

## Paper Trading Config

In the **Paper Trading** tab, you can adjust:

| Setting | Default | Description |
|---------|---------|-------------|
| Trade size | $100 | Simulated USD per copy-trade |
| Take profit | 50% | Auto-close when position is +50% |
| Stop loss | 30% | Auto-close when position is -30% |
| Max positions | 5 | Maximum simultaneous open positions |
| Daily loss limit | $500 | Stop trading if simulated losses exceed this today |

All data is stored in `server/data/` as JSON files — no database required.

---

## Safety Checks (built for good habits)

Every potential copy-trade runs through:

1. **GoPlus API** — honeypot detection, sell-tax check, mintable/proxy flags
2. **Liquidity check** — skips tokens with < $5K liquidity (via DexScreener)
3. **Max positions** — never holds more than the configured max open at once
4. **Daily loss limit** — pauses trading if simulated daily losses exceed limit
5. **Deduplication** — won't open a second position in a token already held

---

## Deploying to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Select the repo
4. Set **Root Directory** to `/` and **Start Command** to `node server/index.js`
5. Add environment variables in Railway's dashboard if needed
6. Railway auto-assigns a public URL — update `PT_API` in `index.html` to match

### Deploying to Render

1. Push to GitHub
2. [render.com](https://render.com) → **New Web Service**
3. Connect repo, set **Build Command**: `cd server && npm install`
4. Set **Start Command**: `node server/index.js`
5. Free tier works fine for paper trading volumes

---

## Project Structure

```
CryptoSignal/
├── index.html              # Frontend (single-file app)
├── package.json            # Root package (start script)
├── README.md
└── server/
    ├── index.js            # Express server + paper trading engine
    ├── walletMonitor.js    # Polls Solana wallets every 15s via RPC
    ├── priceFetcher.js     # DexScreener price + liquidity fetching
    ├── safetyChecker.js    # GoPlus honeypot/rug detection
    ├── package.json
    └── data/               # Auto-created at runtime
        ├── trades.json     # Open + closed paper trades
        ├── wallets.json    # Tracked wallet addresses
        ├── config.json     # Trading config (overrides defaults)
        └── seen_txs.json   # Deduplication cache
```

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Server health check |
| GET | `/api/stats` | Portfolio summary (P&L, win rate, counts) |
| GET | `/api/trades` | All open + closed trades |
| POST | `/api/trades/:id/close` | Manually close an open position |
| POST | `/api/trades/reset` | Wipe all trade data |
| GET | `/api/config` | Current trading config |
| POST | `/api/config` | Update trading config |
| GET | `/api/wallets` | List tracked wallets |
| POST | `/api/wallets` | Add a wallet `{ address, chain }` |
| DELETE | `/api/wallets/:address` | Remove a wallet |
