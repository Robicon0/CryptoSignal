# CryptoSignal — Product Requirements Document

## What This Is
Automated crypto paper-trading platform on Solana. Discovers trending tokens, finds early buyer wallets, scores their win rate, auto-tracks winners, and simulates copy-trades.

## Current State (What's Built)
- Phase 1: Dashboard with DexScreener trending tokens — DONE
- Phase 2: Smart wallet tracking with Bitquery + Moralis — DONE
- Phase 3: Paper trading backend on Railway (web-production-62eb6.up.railway.app) — DONE
- Automated pipeline running: scan every 5 min, monitor wallets every 15s
- 80+ wallets tracked, but 0 paper trades executed yet

## Current Config
- Trade size: $25
- Exit: sell 25% at 1.5x / 2x / 4x / 8x
- Stop loss: 30%
- Max positions: 10
- Min liquidity: $3K
- APIs: Moralis (primary), Solana RPC (fallback), Bitquery (quota exceeded)

## Known Issues (Fix in Order)
1. Token cache too aggressive (6h) — reduce to 1h
2. Wallet monitor not logging activity — add logging
3. No paper trades executing — debug why tracked wallets show 0 new buys

## Upcoming Features (Build After Fixes)
- Morning scan dashboard: overnight activity summary
- Grok AI synthesis with prompt templates for token analysis
- Nansen/Arkham integration for deeper wallet analysis
- Convergence detection: alert when multiple signals align
- Telegram alerts for high-conviction setups
- Transition from paper to live trading once validated

## Platform Expansion — All-in-One Crypto Command Center

The website is expanding from a trading bot into a complete daily crypto research platform. Same website, new homepage with sections. All existing features (trending tokens, smart wallets, paper trading) stay as they are.

### New Homepage Layout
A landing page with navigation to all sections:
- Crypto News & Trends
- Best Yields
- Macro Dashboard
- Trending Tokens (existing)
- Smart Wallets (existing)
- Paper Trading (existing)

### Section 1: Crypto News & Trends (BUILD FIRST)
- Aggregate crypto news from major sources (CoinDesk, CoinTelegraph, The Block, Decrypt)
- Show trending crypto topics from X/Twitter
- Reddit crypto sentiment (r/cryptocurrency, r/bitcoin, r/solana)
- AI summary of top stories (when Grok is connected)
- Auto-refresh every 15 minutes

### Section 2: Best Yields (BUILD SECOND)
- Compare APY/APR across DeFi platforms for:
  - Stablecoins (USDC, USDT, DAI)
  - BTC
  - ETH
  - SOL
  - SUI
- Sources: DeFiLlama API (free), on-chain yield data
- Sort by highest yield, filter by chain and risk level
- Show platform name, APY, TVL, chain

### Section 3: Macro Dashboard (BUILD THIRD)
- Federal Reserve interest rate decisions
- US Dollar index (DXY)
- Bitcoin dominance
- Fear & Greed index
- Key economic calendar events affecting crypto
- Money supply data (M2)
- Gold/BTC correlation

### Build Rules
- One section at a time
- Each section = separate tab/page on the website
- Use free APIs only (under $50/month budget)
- Keep existing features untouched
- Test each section before moving to next

## Tech Stack
- Frontend: Single index.html with vanilla JS
- Backend: Node.js + Express (server/ folder)
- Hosting: Railway (backend), GitHub Pages + Vercel (frontend)
- APIs: DexScreener, Moralis, Bitquery V2, Grok (pending credits)

## Rules
- Solana only for now
- Paper trading only — NO real money until validated
- All API keys as Railway environment variables
- Keep changes minimal — fix only what's broken
- Test before pushing
