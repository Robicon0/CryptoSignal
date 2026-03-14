'use strict';

const fs   = require('fs');
const path = require('path');
const { fetchTokenData, fetchPrices, fetchWalletBuysViaRPC } = require('./priceFetcher');
const { checkTokenSafety, checkLiquidity } = require('./safetyChecker');

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const POLL_INTERVAL_MS = 15_000; // 15 seconds
const DATA_DIR         = path.join(__dirname, 'data');
const WALLETS_FILE     = path.join(DATA_DIR, 'wallets.json');
const SEEN_FILE        = path.join(DATA_DIR, 'seen_txs.json');

// ─────────────────────────────────────────────
// Wallet store
// ─────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadWallets() {
  ensureDataDir();
  if (!fs.existsSync(WALLETS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8')); }
  catch { return []; }
}

function saveWallets(wallets) {
  ensureDataDir();
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
}

function loadSeen() {
  ensureDataDir();
  if (!fs.existsSync(SEEN_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); }
  catch { return {}; }
}

function saveSeen(seen) {
  ensureDataDir();
  // Keep only last 1000 seen tx IDs to prevent unbounded growth
  const keys = Object.keys(seen);
  if (keys.length > 1000) {
    const trimmed = {};
    keys.slice(-1000).forEach(k => { trimmed[k] = seen[k]; });
    fs.writeFileSync(SEEN_FILE, JSON.stringify(trimmed, null, 2));
  } else {
    fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
  }
}

// Public API
function getTrackedWallets() { return loadWallets(); }

function addTrackedWallet(address, chain = 'solana', winRate = null, wins = null, losses = null) {
  const wallets = loadWallets();
  if (wallets.some(w => w.address === address)) return wallets.find(w => w.address === address);
  const wallet = {
    address, chain,
    addedAt:     new Date().toISOString(),
    autoTracked: winRate !== null,
    winRate, wins, losses,
  };
  wallets.push(wallet);
  saveWallets(wallets);
  console.log(`[Monitor] Tracking wallet: ${address} (${chain})${winRate !== null ? ` wr=${winRate}%` : ''}`);
  return wallet;
}

function removeTrackedWallet(address) {
  const wallets = loadWallets();
  const idx = wallets.findIndex(w => w.address === address);
  if (idx === -1) return false;
  wallets.splice(idx, 1);
  saveWallets(wallets);
  console.log(`[Monitor] Removed wallet: ${address}`);
  return true;
}

// ─────────────────────────────────────────────
// Monitor loop
// ─────────────────────────────────────────────
let _openPosition   = null;
let _updatePositions = null;
let _pollTimer      = null;

async function pollWallets() {
  const wallets = loadWallets();
  if (wallets.length === 0) return;

  console.log(`[Monitor] Polling ${wallets.length} wallet(s)`);

  const seen = loadSeen();
  let seenChanged = false;

  // ── 1. Check each Solana wallet for new buys ──
  for (const wallet of wallets) {
    if (wallet.chain !== 'solana') continue;

    try {
      const buys = await fetchWalletBuysViaRPC(wallet.address);
      console.log(`[Monitor] ${wallet.address.slice(0, 8)}… → ${buys.length} recent buy(s) detected`);

      for (const buy of buys) {
        // Deduplicate by token + wallet + ~timestamp bucket (1-minute window)
        const bucket = new Date(buy.timestamp).toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
        const seenKey = `${wallet.address}:${buy.tokenAddress}:${bucket}`;
        if (seen[seenKey]) continue;

        console.log(`[Monitor] New buy detected: wallet=${wallet.address.slice(0, 8)} token=${buy.tokenAddress}`);

        // Fetch current price + liquidity
        const tokenData = await fetchTokenData(buy.tokenAddress);
        if (!tokenData || tokenData.price === 0) {
          console.log(`[Monitor] Skipping ${buy.tokenAddress} — no price data`);
          seen[seenKey] = Date.now();
          seenChanged = true;
          continue;
        }

        // Safety: liquidity check
        const liqCheck = checkLiquidity(tokenData.liquidityUsd);
        if (!liqCheck.ok) {
          console.log(`[Monitor] Skipping ${buy.tokenAddress} — ${liqCheck.reason}`);
          seen[seenKey] = Date.now();
          seenChanged = true;
          continue;
        }

        // Safety: GoPlus honeypot / rug check
        const safetyResult = await checkTokenSafety(buy.tokenAddress, wallet.chain);
        if (!safetyResult.safe) {
          console.log(`[Monitor] Skipping ${buy.tokenAddress} — safety fail: ${safetyResult.reasons.join(', ')}`);
          seen[seenKey] = Date.now();
          seenChanged = true;
          continue;
        }

        // Open paper position
        if (_openPosition) {
          _openPosition({
            tokenAddress:  buy.tokenAddress,
            symbol:        tokenData.symbol || buy.symbol || buy.tokenAddress.slice(0, 8),
            price:         tokenData.price,
            walletAddress: wallet.address,
            chain:         wallet.chain,
            walletWinRate: wallet.winRate  ?? null,
            walletWins:    wallet.wins     ?? null,
            walletLosses:  wallet.losses   ?? null,
          });
        }

        seen[seenKey] = Date.now();
        seenChanged = true;
      }
    } catch (err) {
      console.error(`[Monitor] Poll error for ${wallet.address}:`, err.message);
    }
  }

  if (seenChanged) saveSeen(seen);

  // ── 2. Update open positions with current prices ──
  if (_updatePositions) {
    // Collect all open position token addresses from the trades file
    const tradesFile = path.join(DATA_DIR, 'trades.json');
    if (fs.existsSync(tradesFile)) {
      try {
        const trades = JSON.parse(fs.readFileSync(tradesFile, 'utf8'));
        const openAddresses = trades.open.map(t => t.tokenAddress).filter(Boolean);
        if (openAddresses.length > 0) {
          const priceMap = await fetchPrices(openAddresses);
          _updatePositions(priceMap);
        }
      } catch { /* ignore */ }
    }
  }
}

function startMonitor({ openPosition, updatePositions }) {
  _openPosition    = openPosition;
  _updatePositions = updatePositions;

  if (_pollTimer) clearInterval(_pollTimer);

  console.log(`[Monitor] Starting wallet monitor — polling every ${POLL_INTERVAL_MS / 1000}s`);
  _pollTimer = setInterval(() => {
    pollWallets().catch(err => console.error('[Monitor] Unhandled poll error:', err));
  }, POLL_INTERVAL_MS);

  // Run once immediately
  pollWallets().catch(err => console.error('[Monitor] Initial poll error:', err));
}

function stopMonitor() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = null;
  console.log('[Monitor] Stopped');
}

module.exports = {
  startMonitor, stopMonitor,
  getTrackedWallets, addTrackedWallet, removeTrackedWallet,
};
