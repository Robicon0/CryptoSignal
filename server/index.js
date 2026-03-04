'use strict';

const express    = require('express');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const { startMonitor, getTrackedWallets, addTrackedWallet, removeTrackedWallet } = require('./walletMonitor');

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const PORT            = process.env.PORT || 3001;
const DATA_DIR        = path.join(__dirname, 'data');
const TRADES_FILE     = path.join(DATA_DIR, 'trades.json');
const CONFIG_FILE     = path.join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
  tradeSize:       100,   // USD per simulated trade
  takeProfitPct:   50,    // close at +50%
  stopLossPct:     30,    // close at -30%
  maxOpenPositions: 5,
  dailyLossLimit:  500,   // USD
  minLiquidityUSD: 5000,
};

// ─────────────────────────────────────────────
// Data helpers
// ─────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadTrades() {
  ensureDataDir();
  if (!fs.existsSync(TRADES_FILE)) return { open: [], closed: [] };
  try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); }
  catch { return { open: [], closed: [] }; }
}

function saveTrades(trades) {
  ensureDataDir();
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

function loadConfig() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}

function saveConfig(cfg) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ─────────────────────────────────────────────
// Paper trading engine
// ─────────────────────────────────────────────

/**
 * Open a simulated buy position.
 * @param {object} signal  - { tokenAddress, symbol, price, walletAddress, chain }
 * @returns {object|null}  - the new trade, or null if rejected
 */
function openPosition(signal) {
  const cfg    = loadConfig();
  const trades = loadTrades();
  const today  = new Date().toISOString().slice(0, 10);

  // Safety: max open positions
  if (trades.open.length >= cfg.maxOpenPositions) {
    console.log(`[PaperTrade] Skipping ${signal.symbol} — max open positions (${cfg.maxOpenPositions}) reached`);
    return null;
  }

  // Safety: daily loss limit
  const todayLosses = trades.closed
    .filter(t => t.closedAt?.startsWith(today) && t.pnl < 0)
    .reduce((sum, t) => sum + Math.abs(t.pnl), 0);
  if (todayLosses >= cfg.dailyLossLimit) {
    console.log(`[PaperTrade] Skipping ${signal.symbol} — daily loss limit $${cfg.dailyLossLimit} reached`);
    return null;
  }

  // Avoid duplicate open positions for same token
  if (trades.open.some(t => t.tokenAddress === signal.tokenAddress)) {
    console.log(`[PaperTrade] Skipping ${signal.symbol} — already have open position`);
    return null;
  }

  const trade = {
    id:           `trade_${Date.now()}`,
    tokenAddress: signal.tokenAddress,
    symbol:       signal.symbol || signal.tokenAddress.slice(0, 8),
    chain:        signal.chain || 'solana',
    walletAddress: signal.walletAddress,
    entryPrice:   signal.price,
    currentPrice: signal.price,
    amount:       cfg.tradeSize,
    tokens:       signal.price > 0 ? cfg.tradeSize / signal.price : 0,
    pnl:          0,
    pnlPct:       0,
    openedAt:     new Date().toISOString(),
    closedAt:     null,
    closeReason:  null,
    status:       'open',
    takeProfitPct: cfg.takeProfitPct,
    stopLossPct:   cfg.stopLossPct,
  };

  trades.open.push(trade);
  saveTrades(trades);
  console.log(`[PaperTrade] Opened position: ${trade.symbol} @ $${trade.entryPrice} (id: ${trade.id})`);
  return trade;
}

/**
 * Update all open positions with current prices and trigger TP/SL.
 * Called by the wallet monitor on each poll.
 * @param {Map<string,number>} priceMap - tokenAddress -> current price
 */
function updatePositions(priceMap) {
  const trades = loadTrades();
  let changed = false;

  for (let i = trades.open.length - 1; i >= 0; i--) {
    const t = trades.open[i];
    const cur = priceMap.get(t.tokenAddress);
    if (cur === undefined || cur <= 0) continue;

    t.currentPrice = cur;
    t.pnl    = (cur - t.entryPrice) * t.tokens;
    t.pnlPct = ((cur - t.entryPrice) / t.entryPrice) * 100;
    changed = true;

    let closeReason = null;
    if (t.pnlPct >=  t.takeProfitPct) closeReason = 'take_profit';
    if (t.pnlPct <= -t.stopLossPct)   closeReason = 'stop_loss';

    if (closeReason) {
      t.closedAt   = new Date().toISOString();
      t.closeReason = closeReason;
      t.status     = 'closed';
      trades.closed.push(t);
      trades.open.splice(i, 1);
      console.log(`[PaperTrade] Closed ${t.symbol}: ${closeReason} @ $${cur} | PnL: $${t.pnl.toFixed(2)} (${t.pnlPct.toFixed(1)}%)`);
    }
  }

  if (changed) saveTrades(trades);
}

/**
 * Manually close a position by id.
 */
function closePosition(id, reason = 'manual') {
  const trades = loadTrades();
  const idx = trades.open.findIndex(t => t.id === id);
  if (idx === -1) return null;

  const t = trades.open[idx];
  t.closedAt   = new Date().toISOString();
  t.closeReason = reason;
  t.status     = 'closed';
  trades.closed.push(t);
  trades.open.splice(idx, 1);
  saveTrades(trades);
  return t;
}

/**
 * Portfolio summary stats.
 */
function getStats() {
  const trades = loadTrades();
  const allClosed = trades.closed;

  const totalPnl     = allClosed.reduce((s, t) => s + (t.pnl || 0), 0);
  const openPnl      = trades.open.reduce((s, t) => s + (t.pnl || 0), 0);
  const wins         = allClosed.filter(t => t.pnl > 0).length;
  const losses       = allClosed.filter(t => t.pnl <= 0).length;
  const winRate      = allClosed.length ? Math.round((wins / allClosed.length) * 100) : 0;

  const today = new Date().toISOString().slice(0, 10);
  const dailyPnl = allClosed
    .filter(t => t.closedAt?.startsWith(today))
    .reduce((s, t) => s + (t.pnl || 0), 0);

  return {
    openPositions:  trades.open.length,
    closedTrades:   allClosed.length,
    totalPnl:       parseFloat(totalPnl.toFixed(2)),
    openPnl:        parseFloat(openPnl.toFixed(2)),
    dailyPnl:       parseFloat(dailyPnl.toFixed(2)),
    wins,
    losses,
    winRate,
  };
}

// ─────────────────────────────────────────────
// Express app
// ─────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend from project root
app.use(express.static(path.join(__dirname, '..')));

// ── Health ──────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Config ──────────────────────────────────
app.get('/api/config', (_req, res) => res.json(loadConfig()));

app.post('/api/config', (req, res) => {
  const cfg = { ...loadConfig(), ...req.body };
  saveConfig(cfg);
  res.json(cfg);
});

// ── Trades ──────────────────────────────────
app.get('/api/trades', (_req, res) => {
  const trades = loadTrades();
  res.json(trades);
});

app.get('/api/stats', (_req, res) => res.json(getStats()));

// Close a position manually
app.post('/api/trades/:id/close', (req, res) => {
  const closed = closePosition(req.params.id, 'manual');
  if (!closed) return res.status(404).json({ error: 'Trade not found or already closed' });
  res.json(closed);
});

// Reset / clear all trades
app.post('/api/trades/reset', (_req, res) => {
  saveTrades({ open: [], closed: [] });
  res.json({ ok: true });
});

// ── Wallets ──────────────────────────────────
app.get('/api/wallets', (_req, res) => res.json(getTrackedWallets()));

app.post('/api/wallets', (req, res) => {
  const { address, chain } = req.body;
  if (!address) return res.status(400).json({ error: 'address required' });
  const wallet = addTrackedWallet(address, chain || 'solana');
  res.json(wallet);
});

app.delete('/api/wallets/:address', (req, res) => {
  const ok = removeTrackedWallet(req.params.address);
  if (!ok) return res.status(404).json({ error: 'Wallet not found' });
  res.json({ ok: true });
});

// ── Start server ─────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] CryptoSignal backend running on http://localhost:${PORT}`);
  startMonitor({ openPosition, updatePositions });
});

module.exports = { openPosition, updatePositions, closePosition, getStats };
