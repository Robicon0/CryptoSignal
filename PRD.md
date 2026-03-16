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
