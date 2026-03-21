'use strict';

const express    = require('express');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');

const { startMonitor, getTrackedWallets, addTrackedWallet, removeTrackedWallet } = require('./walletMonitor');
const { startScanner, getStatus: getScannerStatus, getActivity, appendActivity }  = require('./scanner');

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const PORT       = process.env.PORT || 3001;
const DATA_DIR   = path.join(__dirname, 'data');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
  tradeSize:        25,
  stopLossPct:      30,
  maxOpenPositions: 10,
  dailyLossLimit:   500,
  minLiquidityUSD:  3000,
  bitqueryKey:      '',   // synced from frontend Settings
  moralisKey:       '',   // synced from frontend Settings
};

// Scaled exit tranches: sell 25% of original tokens at each level
const SCALE_EXITS = [
  { tranche: 1, pctGain: 50   },  // 1.5x
  { tranche: 2, pctGain: 100  },  // 2x
  { tranche: 3, pctGain: 300  },  // 4x
  { tranche: 4, pctGain: 700  },  // 8x
];

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

function saveTrades(data) {
  ensureDataDir();
  fs.writeFileSync(TRADES_FILE, JSON.stringify(data, null, 2));
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
function openPosition(signal) {
  const cfg    = loadConfig();
  const trades = loadTrades();
  const today  = new Date().toISOString().slice(0, 10);

  if (trades.open.length >= cfg.maxOpenPositions) {
    const msg = `Skipping ${signal.symbol} — max ${cfg.maxOpenPositions} open positions reached`;
    console.log(`[PaperTrade] ${msg}`);
    appendActivity('skip', msg, { reason: 'max_positions', symbol: signal.symbol });
    return null;
  }

  const todayLosses = trades.closed
    .filter(t => t.closedAt?.startsWith(today) && t.pnl < 0)
    .reduce((sum, t) => sum + Math.abs(t.pnl), 0);
  if (todayLosses >= cfg.dailyLossLimit) {
    const msg = `Skipping ${signal.symbol} — daily loss limit $${cfg.dailyLossLimit} reached`;
    console.log(`[PaperTrade] ${msg}`);
    appendActivity('skip', msg, { reason: 'daily_loss_limit', symbol: signal.symbol });
    return null;
  }

  if (trades.open.some(t => t.tokenAddress === signal.tokenAddress)) {
    console.log(`[PaperTrade] Skipping ${signal.symbol} — already open`);
    return null;
  }

  const totalTokens = signal.price > 0 ? cfg.tradeSize / signal.price : 0;
  const trade = {
    id:               `trade_${Date.now()}`,
    tokenAddress:     signal.tokenAddress,
    symbol:           signal.symbol || signal.tokenAddress.slice(0, 8),
    chain:            signal.chain || 'solana',
    walletAddress:    signal.walletAddress,
    walletWinRate:    signal.walletWinRate ?? null,
    walletWins:       signal.walletWins    ?? null,
    walletLosses:     signal.walletLosses  ?? null,
    entryPrice:       signal.price,
    currentPrice:     signal.price,
    amount:           cfg.tradeSize,
    tokens:           totalTokens,
    remainingTokens:  totalTokens,
    tranchesSold:     0,
    realizedPnl:      0,
    partialSells:     [],
    pnl:              0,
    pnlPct:           0,
    openedAt:         new Date().toISOString(),
    closedAt:         null,
    closeReason:      null,
    status:           'open',
    stopLossPct:      cfg.stopLossPct,
  };

  trades.open.push(trade);
  saveTrades(trades);

  const wrLabel = signal.walletWinRate != null ? ` (wallet ${signal.walletWinRate}% wr)` : '';
  const msg = `TRADE OPENED: ${trade.symbol} @ $${Number(trade.entryPrice).toPrecision(5)} — $${cfg.tradeSize} simulated${wrLabel}`;
  console.log(`[PaperTrade] ${msg}`);
  appendActivity('trade_open', msg, {
    tradeId:       trade.id,
    symbol:        trade.symbol,
    tokenAddress:  trade.tokenAddress,
    entryPrice:    trade.entryPrice,
    amount:        cfg.tradeSize,
    walletAddress: signal.walletAddress,
    walletWinRate: signal.walletWinRate,
  });

  return trade;
}

function updatePositions(priceMap) {
  const trades  = loadTrades();
  let changed   = false;

  for (let i = trades.open.length - 1; i >= 0; i--) {
    const t   = trades.open[i];
    const cur = priceMap.get(t.tokenAddress);
    if (cur === undefined || cur <= 0) continue;

    t.currentPrice = cur;
    const pnlPct   = ((cur - t.entryPrice) / t.entryPrice) * 100;
    t.pnlPct       = pnlPct;

    // Migrate old trades that lack scaled-exit fields
    if (t.remainingTokens === undefined) t.remainingTokens = t.tokens;
    if (t.tranchesSold    === undefined) t.tranchesSold    = 0;
    if (t.realizedPnl     === undefined) t.realizedPnl     = 0;
    if (t.partialSells    === undefined) t.partialSells    = [];

    changed = true;

    // ── Stop loss: close entire remaining position ──
    const slPct = t.stopLossPct ?? 30;
    if (pnlPct <= -slPct) {
      const slPnl = (cur - t.entryPrice) * t.remainingTokens;
      t.realizedPnl  += slPnl;
      t.pnl           = parseFloat((t.realizedPnl).toFixed(2));
      t.closedAt      = new Date().toISOString();
      t.closeReason   = 'stop_loss';
      t.status        = 'closed';
      trades.closed.push(t);
      trades.open.splice(i, 1);

      const totalSign = t.pnl >= 0 ? '+' : '';
      const msg = `🔴 STOP LOSS: ${t.symbol} closed @ $${Number(cur).toPrecision(5)} | Total P&L ${totalSign}$${t.pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`;
      console.log(`[PaperTrade] ${msg}`);
      appendActivity('trade_close', msg, {
        tradeId: t.id, symbol: t.symbol, closeReason: 'stop_loss',
        pnl: t.pnl, pnlPct: parseFloat(pnlPct.toFixed(1)),
        entryPrice: t.entryPrice, exitPrice: cur,
        walletAddress: t.walletAddress, walletWinRate: t.walletWinRate,
      });
      continue;
    }

    // ── Scaled exits: check each unsold tranche ──
    const trancheTokens = t.tokens / 4; // 25% of original tokens per tranche
    for (const exit of SCALE_EXITS) {
      if (t.tranchesSold >= exit.tranche) continue;       // already sold
      if (pnlPct < exit.pctGain)           continue;      // not reached yet
      if (t.remainingTokens <= 0)          break;

      // Sell this tranche
      const sellTokens = Math.min(trancheTokens, t.remainingTokens);
      const sellPnl    = (cur - t.entryPrice) * sellTokens;
      t.remainingTokens -= sellTokens;
      t.tranchesSold    = exit.tranche;
      t.realizedPnl    += sellPnl;

      const partial = {
        tranche:   exit.tranche,
        pctGain:   exit.pctGain,
        sellPrice: cur,
        sellPnl:   parseFloat(sellPnl.toFixed(2)),
        soldAt:    new Date().toISOString(),
      };
      t.partialSells.push(partial);

      const multiple = (1 + exit.pctGain / 100).toFixed(0);
      const msg = `📈 PARTIAL SELL T${exit.tranche}/4: ${t.symbol} @ $${Number(cur).toPrecision(5)} (${multiple}x) | +$${sellPnl.toFixed(2)} — ${t.tranchesSold}/4 tranches sold`;
      console.log(`[PaperTrade] ${msg}`);
      appendActivity('partial_sell', msg, {
        tradeId: t.id, symbol: t.symbol,
        tranche: exit.tranche, pctGain: exit.pctGain,
        sellPrice: cur, sellPnl: partial.sellPnl,
        walletAddress: t.walletAddress, walletWinRate: t.walletWinRate,
      });
    }

    // Update unrealized P&L on remaining tokens
    const unrealized = (cur - t.entryPrice) * t.remainingTokens;
    t.pnl = parseFloat((t.realizedPnl + unrealized).toFixed(2));

    // If all 4 tranches sold, close the position
    if (t.tranchesSold >= 4 || t.remainingTokens <= 0) {
      t.closedAt    = new Date().toISOString();
      t.closeReason = 'take_profit';
      t.status      = 'closed';
      trades.closed.push(t);
      trades.open.splice(i, 1);

      const totalSign = t.pnl >= 0 ? '+' : '';
      const msg = `✅ FULL EXIT: ${t.symbol} all 4 tranches sold | Total P&L ${totalSign}$${t.pnl.toFixed(2)}`;
      console.log(`[PaperTrade] ${msg}`);
      appendActivity('trade_close', msg, {
        tradeId: t.id, symbol: t.symbol, closeReason: 'take_profit',
        pnl: t.pnl, entryPrice: t.entryPrice, exitPrice: cur,
        walletAddress: t.walletAddress, walletWinRate: t.walletWinRate,
      });
    }
  }

  if (changed) saveTrades(trades);
}

function closePosition(id, reason = 'manual') {
  const trades = loadTrades();
  const idx    = trades.open.findIndex(t => t.id === id);
  if (idx === -1) return null;

  const t = trades.open[idx];

  // Add unrealized P&L on remaining tokens at current price
  const remaining = t.remainingTokens ?? t.tokens;
  const unrealized = (t.currentPrice - t.entryPrice) * remaining;
  const realized   = t.realizedPnl ?? 0;
  t.pnl = parseFloat((realized + unrealized).toFixed(2));

  t.closedAt    = new Date().toISOString();
  t.closeReason = reason;
  t.status      = 'closed';
  trades.closed.push(t);
  trades.open.splice(idx, 1);
  saveTrades(trades);

  appendActivity('trade_close',
    `MANUAL CLOSE: ${t.symbol} | P&L ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}`, {
      tradeId: t.id, symbol: t.symbol, closeReason: reason,
      pnl: t.pnl,
    });
  return t;
}

function getStats() {
  const trades    = loadTrades();
  const allClosed = trades.closed;
  const today     = new Date().toISOString().slice(0, 10);

  const totalPnl = allClosed.reduce((s, t) => s + (t.pnl || 0), 0);
  const openPnl  = trades.open.reduce((s, t) => s + (t.pnl || 0), 0);
  const wins     = allClosed.filter(t => t.pnl > 0).length;
  const losses   = allClosed.filter(t => t.pnl <= 0).length;
  const winRate  = allClosed.length ? Math.round((wins / allClosed.length) * 100) : 0;
  const dailyPnl = allClosed
    .filter(t => t.closedAt?.startsWith(today))
    .reduce((s, t) => s + (t.pnl || 0), 0);

  return {
    openPositions:  trades.open.length,
    closedTrades:   allClosed.length,
    totalPnl:       parseFloat(totalPnl.toFixed(2)),
    openPnl:        parseFloat(openPnl.toFixed(2)),
    dailyPnl:       parseFloat(dailyPnl.toFixed(2)),
    wins, losses, winRate,
  };
}

// ─────────────────────────────────────────────
// RSS / News helpers
// ─────────────────────────────────────────────
const fetch = require('node-fetch');

// Simple regex-based RSS item extractor — no extra dependencies needed
function parseRssItems(xml, source) {
  const items = [];
  const itemRx = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRx.exec(xml)) !== null) {
    const block = m[1];
    const title   = (/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/.exec(block) || /<title>([\s\S]*?)<\/title>/.exec(block) || [])[1] || '';
    const link    = (/<link>([\s\S]*?)<\/link>/.exec(block) || /<link href="([^"]+)"/.exec(block) || [])[1] || '';
    const pubDate = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(block) || [])[1] || '';
    const desc    = (/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/.exec(block) || /<description>([\s\S]*?)<\/description>/.exec(block) || [])[1] || '';
    if (title && link) {
      items.push({
        title:   title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim(),
        link:    link.trim(),
        pubDate: pubDate.trim(),
        source,
        // Strip HTML tags from description, limit to 160 chars
        desc:    desc.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0,160),
      });
    }
  }
  return items;
}

const NEWS_FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',  source: 'CoinDesk'     },
  { url: 'https://cointelegraph.com/rss',                    source: 'CoinTelegraph' },
  { url: 'https://theblock.co/rss.xml',                      source: 'The Block'    },
  { url: 'https://decrypt.co/feed',                          source: 'Decrypt'      },
];

let _newsCache   = null;
let _newsCacheTs = 0;
const NEWS_TTL   = 15 * 60 * 1000; // 15 minutes

async function fetchAllNews() {
  if (_newsCache && Date.now() - _newsCacheTs < NEWS_TTL) return _newsCache;

  const results = await Promise.allSettled(
    NEWS_FEEDS.map(async ({ url, source }) => {
      const r = await fetch(url, { timeout: 10000, headers: { 'User-Agent': 'CryptoSignal/1.0' } });
      const xml = await r.text();
      return parseRssItems(xml, source);
    })
  );

  const all = [];
  results.forEach(r => { if (r.status === 'fulfilled') all.push(...r.value); });

  // Sort by pubDate descending, newest first
  all.sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return db - da;
  });

  _newsCache   = all.slice(0, 40);
  _newsCacheTs = Date.now();
  return _newsCache;
}

let _redditCache   = null;
let _redditCacheTs = 0;

async function fetchRedditPosts() {
  if (_redditCache && Date.now() - _redditCacheTs < NEWS_TTL) return _redditCache;

  const subs = ['CryptoCurrency', 'Bitcoin', 'solana'];
  const results = await Promise.allSettled(
    subs.map(async sub => {
      const r = await fetch(
        `https://www.reddit.com/r/${sub}/hot.json?limit=8`,
        { timeout: 10000, headers: { 'User-Agent': 'CryptoSignal/1.0' } }
      );
      const json = await r.json();
      return (json?.data?.children || []).map(c => ({
        title:     c.data.title,
        link:      `https://www.reddit.com${c.data.permalink}`,
        score:     c.data.score,
        comments:  c.data.num_comments,
        subreddit: c.data.subreddit,
        created:   c.data.created_utc * 1000,
      }));
    })
  );

  const all = [];
  results.forEach(r => { if (r.status === 'fulfilled') all.push(...r.value); });
  all.sort((a, b) => b.score - a.score);

  _redditCache   = all.slice(0, 20);
  _redditCacheTs = Date.now();
  return _redditCache;
}

// ─────────────────────────────────────────────
// Express app
// ─────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── Page routing (must come before express.static) ───────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'home.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));

app.use(express.static(path.join(__dirname, '..')));

// ── Health ──────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Env-provided public keys (Grok) ─────────
// Only exposes keys that are safe for the frontend — never bitquery/moralis.
app.get('/api/env-keys', (_req, res) => {
  res.json({ grokKey: process.env.GROK_API_KEY || '' });
});

// ── Config ──────────────────────────────────
app.get('/api/config', (_req, res) => {
  const cfg = loadConfig();
  const safe = { ...cfg };
  safe.bitqueryKeySet = !!safe.bitqueryKey;
  safe.moralisKeySet  = !!safe.moralisKey;
  delete safe.bitqueryKey;
  delete safe.moralisKey;
  res.json(safe);
});

app.post('/api/config', (req, res) => {
  const incoming = req.body;
  const cfg = { ...loadConfig(), ...incoming };
  saveConfig(cfg);
  const safe = { ...cfg };
  safe.bitqueryKeySet = !!safe.bitqueryKey;
  safe.moralisKeySet  = !!safe.moralisKey;
  delete safe.bitqueryKey;
  delete safe.moralisKey;
  res.json(safe);
});

// ── Trades ──────────────────────────────────
app.get('/api/trades', (_req, res) => res.json(loadTrades()));
app.get('/api/stats',  (_req, res) => res.json(getStats()));

app.post('/api/trades/:id/close', (req, res) => {
  const closed = closePosition(req.params.id, 'manual');
  if (!closed) return res.status(404).json({ error: 'Trade not found or already closed' });
  res.json(closed);
});

app.post('/api/trades/reset', (_req, res) => {
  saveTrades({ open: [], closed: [] });
  appendActivity('info', 'All paper trade data reset by user');
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

// ── Test scan (debug endpoint) ───────────────
app.get('/api/test-scan', async (req, res) => {
  const fetch = require('node-fetch');
  const { fetchTrendingTokens } = require('./scanner');
  const { fetchEarlyBuyersBq, fetchEarlyBuyersMoralis, fetchEarlyBuyersRPC } = require('./bitquery');
  const cfg = loadConfig();

  const report = {
    timestamp: new Date().toISOString(),
    config: { bitqueryKeySet: !!cfg.bitqueryKey, moralisKeySet: !!cfg.moralisKey },
    token: null,
    strategies: {},
  };

  try {
    let tokenAddress = req.query.token || null;
    let pairAddress  = req.query.pair  || null;
    let symbol       = tokenAddress ? tokenAddress.slice(0, 8) : null;

    if (!tokenAddress) {
      const tokens = await fetchTrendingTokens();
      const top = tokens.find(t => t.liquidityUsd >= 50000) || tokens[0];
      if (!top) return res.status(503).json({ error: 'No trending tokens found from DexScreener' });
      tokenAddress = top.address;
      pairAddress  = top.pairAddress || null;
      symbol       = top.symbol;
    }

    report.token = { address: tokenAddress, symbol, pairAddress };

    // Strategy 1: Bitquery
    const t1 = Date.now();
    try {
      const buyers = await fetchEarlyBuyersBq(tokenAddress, cfg.bitqueryKey, 5);
      report.strategies.bitquery = { status: 'ok', count: buyers.length, buyers: buyers.slice(0, 3), ms: Date.now() - t1 };
    } catch (err) {
      report.strategies.bitquery = { status: 'error', error: err.message, ms: Date.now() - t1 };
    }

    // Strategy 2: Moralis (raw response shown)
    const t2 = Date.now();
    if (cfg.moralisKey) {
      try {
        const url = `https://solana-gateway.moralis.io/token/mainnet/${tokenAddress}/swaps?order=ASC&limit=5`;
        const r   = await fetch(url, { headers: { 'X-API-Key': cfg.moralisKey, Accept: 'application/json' }, timeout: 15000 });
        const raw = await r.text();
        let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        const buyers = Array.isArray(parsed?.result)
          ? parsed.result.map(s => ({ address: s.walletAddress || s.from, raw: s })).filter(b => b.address)
          : [];
        report.strategies.moralis = {
          status: r.ok ? 'ok' : 'error', httpStatus: r.status,
          count: buyers.length, buyers: buyers.slice(0, 3),
          rawResultSample: Array.isArray(parsed?.result) ? parsed.result.slice(0, 2) : parsed,
          ms: Date.now() - t2,
        };
      } catch (err) {
        report.strategies.moralis = { status: 'error', error: err.message, ms: Date.now() - t2 };
      }
    } else {
      report.strategies.moralis = { status: 'skipped', reason: 'no MORALIS_API_KEY' };
    }

    // Strategy 3: Solana RPC with pair address
    const t3 = Date.now();
    const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const searchAddr = pairAddress || tokenAddress;
    report.strategies.rpc = { searchAddress: searchAddr, usingPairAddress: !!pairAddress };
    try {
      const sigR = await fetch(RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [searchAddr, { limit: 20 }] }),
        timeout: 12000,
      });
      const sigD = await sigR.json();
      const sigs = sigD?.result || [];
      report.strategies.rpc.sigCount = sigs.length;
      const buyers = await fetchEarlyBuyersRPC(tokenAddress, 5, pairAddress);
      report.strategies.rpc.count   = buyers.length;
      report.strategies.rpc.buyers  = buyers.slice(0, 3);
      report.strategies.rpc.status  = 'ok';
      report.strategies.rpc.ms      = Date.now() - t3;
    } catch (err) {
      report.strategies.rpc.status = 'error';
      report.strategies.rpc.error  = err.message;
      report.strategies.rpc.ms     = Date.now() - t3;
    }

    res.json(report);
  } catch (err) {
    res.status(500).json({ ...report, error: err.message });
  }
});

// ── Test trade (smoke-test the paper trading engine) ─────────────────────────
app.get('/api/test-trade', (_req, res) => {
  const fakeTrade = openPosition({
    tokenAddress:  'TEST' + Date.now(),
    symbol:        'TEST',
    price:         0.001,
    walletAddress: 'TESTwallet00000000000000000000000000000000',
    chain:         'solana',
    walletWinRate: 75,
    walletWins:    3,
    walletLosses:  1,
  });
  if (!fakeTrade) return res.status(409).json({ ok: false, reason: 'openPosition returned null (max positions or daily limit?)' });
  res.json({ ok: true, trade: fakeTrade });
});

// ── News & Reddit ────────────────────────────
app.get('/api/news', async (_req, res) => {
  try {
    const articles = await fetchAllNews();
    res.json({ ok: true, articles, cachedAt: _newsCacheTs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/reddit', async (_req, res) => {
  try {
    const posts = await fetchRedditPosts();
    res.json({ ok: true, posts, cachedAt: _redditCacheTs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Scanner / Activity ───────────────────────
app.get('/api/scanner/status',   (_req, res) => res.json(getScannerStatus()));
app.get('/api/activity',         (req, res)  => res.json(getActivity(parseInt(req.query.limit) || 100)));

// ── Start server ─────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] CryptoSignal backend running on port ${PORT}`);

  // Always apply environment variable keys — env vars win over config.json.
  // This ensures Railway deployments always have fresh keys, even if a stale
  // config.json was somehow persisted across deploys.
  const bqEnv  = process.env.BITQUERY_API_KEY || '';
  const moEnv  = process.env.MORALIS_API_KEY  || '';
  const cfg    = loadConfig();
  let changed  = false;

  if (bqEnv && cfg.bitqueryKey !== bqEnv) { cfg.bitqueryKey = bqEnv; changed = true; }
  if (moEnv && cfg.moralisKey  !== moEnv) { cfg.moralisKey  = moEnv; changed = true; }
  if (changed) {
    saveConfig(cfg);
    console.log('[Server] API keys updated from environment variables');
  }

  // Log current key status so Railway logs make it obvious what's active
  const active = [
    cfg.bitqueryKey ? 'Bitquery ✓' : 'Bitquery ✗ (set BITQUERY_API_KEY)',
    cfg.moralisKey  ? 'Moralis ✓'  : 'Moralis ✗  (set MORALIS_API_KEY)',
    process.env.GROK_API_KEY ? 'Grok ✓' : 'Grok ✗    (set GROK_API_KEY)',
  ];
  console.log('[Server] API key status:');
  active.forEach(s => console.log(`  ${s}`));

  startMonitor({ openPosition, updatePositions });
  startScanner(loadConfig);
});

module.exports = { openPosition, updatePositions, closePosition, getStats };
