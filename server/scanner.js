'use strict';

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

const { fetchEarlyBuyers, scoreWallet, Bq402Error } = require('./bitquery');
const { addTrackedWallet, getTrackedWallets } = require('./walletMonitor');

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const SCAN_INTERVAL_MS   = 5 * 60 * 1000;  // 5 minutes
const FIRST_SCAN_DELAY   = 20 * 1000;       // 20s after boot
const MIN_WIN_RATE       = 50;
const MIN_SCORED_TRADES  = 1;  // require only 1 scored trade; wallets with none are tracked unscored
const MIN_LIQUIDITY_USD  = 5000;
const MAX_TOKENS_PER_SCAN = 10;             // respect Bitquery rate limits
const MAX_BUYERS_PER_TOKEN = 5;             // score only first 5 buyers per token
const TOKEN_SCAN_TTL_MS  = 1 * 60 * 60 * 1000; // skip token if scanned < 1h ago
const REQ_DELAY_MS       = 1200;            // pause between Bitquery calls

const DATA_DIR       = path.join(__dirname, 'data');
const ACTIVITY_FILE  = path.join(DATA_DIR, 'activity.json');
const SCANNED_FILE   = path.join(DATA_DIR, 'scanned_tokens.json');
const MAX_ACTIVITY   = 300;

// ─────────────────────────────────────────────
// Activity log
// ─────────────────────────────────────────────
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadActivity() {
  ensureDir();
  if (!fs.existsSync(ACTIVITY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); }
  catch { return []; }
}

function appendActivity(type, message, detail = null) {
  ensureDir();
  const log   = loadActivity();
  const entry = { type, message, detail, timestamp: new Date().toISOString() };
  log.unshift(entry);
  if (log.length > MAX_ACTIVITY) log.length = MAX_ACTIVITY;
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(log, null, 2));
  console.log(`[Scanner] [${type}] ${message}`);
  return entry;
}

function getActivity(limit = 100) {
  return loadActivity().slice(0, limit);
}

// ─────────────────────────────────────────────
// Scanned-token cache (avoid re-scanning same token within 6h)
// ─────────────────────────────────────────────
function loadScanned() {
  if (!fs.existsSync(SCANNED_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SCANNED_FILE, 'utf8')); }
  catch { return {}; }
}

function markScanned(addr) {
  ensureDir();
  const s   = loadScanned();
  const now = Date.now();
  // Prune expired
  for (const k of Object.keys(s)) {
    if (now - s[k] > TOKEN_SCAN_TTL_MS) delete s[k];
  }
  s[addr] = now;
  fs.writeFileSync(SCANNED_FILE, JSON.stringify(s, null, 2));
}

function wasScanned(addr) {
  const s  = loadScanned();
  const ts = s[addr];
  return ts && (Date.now() - ts) < TOKEN_SCAN_TTL_MS;
}

// ─────────────────────────────────────────────
// DexScreener — fetch trending Solana tokens
// ─────────────────────────────────────────────
async function fetchTrendingTokens() {
  const boostRes = await fetch('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 12000 });
  if (!boostRes.ok) throw new Error(`DexScreener boosts HTTP ${boostRes.status}`);
  const boosts = await boostRes.json();

  const solBoosts = (Array.isArray(boosts) ? boosts : [])
    .filter(b => b.chainId === 'solana')
    .slice(0, 40);

  if (!solBoosts.length) return [];

  const addrs   = solBoosts.map(b => b.tokenAddress).join(',');
  const pairRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addrs}`, { timeout: 12000 });
  if (!pairRes.ok) return [];
  const pairData = await pairRes.json();

  const bestPair = new Map();
  for (const p of (pairData.pairs || [])) {
    const addr = p.baseToken?.address?.toLowerCase();
    if (!addr) continue;
    const cur = bestPair.get(addr);
    if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) bestPair.set(addr, p);
  }

  const tokens = [];
  for (const b of solBoosts) {
    const pair = bestPair.get(b.tokenAddress.toLowerCase());
    if (!pair) continue;
    const liq = pair.liquidity?.usd || 0;
    if (liq < MIN_LIQUIDITY_USD) continue;
    tokens.push({
      address:     b.tokenAddress,
      symbol:      pair.baseToken?.symbol || b.tokenAddress.slice(0, 8),
      liquidityUsd: liq,
      volume24h:   pair.volume?.h24 || 0,
      priceUsd:    parseFloat(pair.priceUsd || 0),
      pairAddress: pair.pairAddress || '',   // pool/AMM address for RPC buyer lookup
    });
  }

  return tokens.sort((a, b) => b.volume24h - a.volume24h);
}

// ─────────────────────────────────────────────
// Scanner status (in-memory)
// ─────────────────────────────────────────────
const status = {
  running:       false,
  lastScanAt:    null,
  nextScanAt:    null,
  tokensScanned: 0,
  walletsScored: 0,
  walletsTracked: 0,
  scansRun:      0,
};

function getStatus() { return { ...status }; }

// ─────────────────────────────────────────────
// Main scan
// ─────────────────────────────────────────────
async function runScan(loadConfig) {
  if (status.running) return;

  const cfg         = loadConfig();
  const bitqueryKey = cfg.bitqueryKey;
  const moralisKey  = cfg.moralisKey || null;

  if (!bitqueryKey && !moralisKey) {
    appendActivity('warn', 'Scanner idle — add Bitquery or Moralis API key in Settings (or set env vars on Railway) to enable automated trading');
    return;
  }

  status.running = true;
  status.scansRun++;
  const t0 = Date.now();

  const keyInfo = [bitqueryKey && 'Bitquery', moralisKey && 'Moralis'].filter(Boolean).join(' + ');
  appendActivity('scan_start', `Automated scan #${status.scansRun} started (keys: ${keyInfo})`);

  try {
    // 1. Fetch trending Solana tokens
    let allTokens;
    try {
      allTokens = await fetchTrendingTokens();
    } catch (err) {
      appendActivity('error', `DexScreener failed: ${err.message}`);
      return;
    }

    const trackedSet  = new Set(getTrackedWallets().map(w => w.address));
    const freshTokens = allTokens.filter(t => !wasScanned(t.address));
    const toScan      = freshTokens.slice(0, MAX_TOKENS_PER_SCAN);

    appendActivity('scan_tokens', `${allTokens.length} trending Solana tokens — scanning ${toScan.length} new`, {
      total: allTokens.length, scanning: toScan.length,
    });

    let walletsScored  = 0;
    let walletsTracked = 0;

    // 2. For each new token: get early buyers → score each wallet
    for (const token of toScan) {
      appendActivity('token_check',
        `→ ${token.symbol} — liq $${Math.round(token.liquidityUsd).toLocaleString()}`, {
          address: token.address, symbol: token.symbol, liquidityUsd: token.liquidityUsd,
        });

      // Fetch early buyers — fetchEarlyBuyers now chains Bitquery → Moralis → RPC automatically
      let buyers;
      try {
        buyers = await fetchEarlyBuyers(token.address, bitqueryKey, MAX_BUYERS_PER_TOKEN, moralisKey, token.pairAddress || '');
      } catch (err) {
        appendActivity('error', `Failed to fetch buyers for ${token.symbol}: ${err.message}`);
        markScanned(token.address);
        await delay(REQ_DELAY_MS);
        continue;
      }

      if (!buyers.length) {
        appendActivity('skip', `${token.symbol}: no buyers found (all strategies returned empty)`);
        markScanned(token.address);
        continue;
      }

      const newBuyers = buyers.filter(b => !trackedSet.has(b.address));
      if (!newBuyers.length) {
        appendActivity('skip', `${token.symbol}: all ${buyers.length} buyers already tracked`);
        markScanned(token.address);
        continue;
      }

      appendActivity('buyers_found', `${token.symbol}: ${buyers.length} buyers found (${newBuyers.length} new to score)`, {
        symbol: token.symbol, total: buyers.length, newCount: newBuyers.length,
      });

      // Score each buyer — scoreWallet chains Bitquery → Moralis → RPC automatically
      for (const buyer of newBuyers) {
        await delay(REQ_DELAY_MS);

        let score;
        try {
          score = await scoreWallet(buyer.address, bitqueryKey, MIN_SCORED_TRADES, moralisKey);
          walletsScored++;
          console.log(`[Scanner] Scored ${buyer.address.slice(0, 8)}: ${score.winRate ?? 'null'}% wr (${score.total} trades, via ${score.via || 'unknown'})`);
        } catch (err) {
          appendActivity('error', `Score failed ${buyer.address.slice(0, 8)}: ${err.message}`);
          console.warn(`[Scanner] Score error ${buyer.address.slice(0, 8)}: ${err.message}`);
          continue;
        }

        const short = buyer.address.slice(0, 8) + '…';

        const via = score.via ? ` [via ${score.via}]` : '';

        if (score.winRate === null) {
          // No trading history to score — track anyway.
          // Being an early buyer confirmed by Moralis/Bitquery IS the signal.
          appendActivity('wallet_tracked',
            `AUTO-TRACKED ${short} (unscored — ${score.total} prior trades) — early buyer of ${token.symbol}${via}`, {
              address: buyer.address, winRate: null,
              wins: score.wins, losses: score.losses, total: score.total,
              foundBuying: token.symbol, foundBuyingAddress: token.address,
            });
          addTrackedWallet(buyer.address, 'solana', null, score.wins, score.losses);
          trackedSet.add(buyer.address);
          walletsTracked++;
          continue;
        }

        if (score.winRate < MIN_WIN_RATE) {
          appendActivity('score_low',
            `${short}: ${score.winRate}% win rate — below ${MIN_WIN_RATE}% threshold${via}`, {
              address: buyer.address, winRate: score.winRate, total: score.total,
            });
          continue;
        }

        // ✅ Auto-track with confirmed win rate
        appendActivity('wallet_tracked',
          `AUTO-TRACKED ${short} — ${score.winRate}% win rate (${score.wins}W / ${score.losses}L) — found buying ${token.symbol}${via}`, {
            address: buyer.address, winRate: score.winRate,
            wins: score.wins, losses: score.losses, total: score.total,
            foundBuying: token.symbol, foundBuyingAddress: token.address,
          });

        addTrackedWallet(buyer.address, 'solana', score.winRate, score.wins, score.losses);
        trackedSet.add(buyer.address);
        walletsTracked++;
      }

      markScanned(token.address);
      await delay(REQ_DELAY_MS);
    }

    // Update totals
    status.tokensScanned += toScan.length;
    status.walletsScored  += walletsScored;
    status.walletsTracked += walletsTracked;
    status.lastScanAt      = new Date().toISOString();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    appendActivity('scan_done',
      `Scan #${status.scansRun} done in ${elapsed}s — ${toScan.length} tokens, ${walletsScored} wallets scored, ${walletsTracked} new wallets tracked`, {
        tokensScanned: toScan.length, walletsScored, walletsTracked,
        elapsedSec: parseFloat(elapsed),
      });

  } catch (err) {
    appendActivity('error', `Unhandled scanner error: ${err.message}`);
    console.error('[Scanner] Unhandled error:', err);
  } finally {
    status.running = false;
  }
}

// ─────────────────────────────────────────────
// Start / stop
// ─────────────────────────────────────────────
let _scanTimer = null;

function startScanner(loadConfig) {
  appendActivity('startup', 'CryptoSignal automated pipeline initializing…');

  // First scan after short delay (let server settle)
  const firstTimer = setTimeout(() => {
    status.nextScanAt = null;
    runScan(loadConfig).catch(err => console.error('[Scanner] First scan error:', err));
  }, FIRST_SCAN_DELAY);
  firstTimer.unref?.();

  // Recurring scan
  _scanTimer = setInterval(() => {
    status.nextScanAt = null;
    runScan(loadConfig).catch(err => console.error('[Scanner] Scan error:', err));
  }, SCAN_INTERVAL_MS);
  _scanTimer.unref?.();

  // Track next scan time
  status.nextScanAt = new Date(Date.now() + FIRST_SCAN_DELAY).toISOString();
  setInterval(() => {
    if (!status.running && status.lastScanAt) {
      const next = new Date(new Date(status.lastScanAt).getTime() + SCAN_INTERVAL_MS);
      status.nextScanAt = next.toISOString();
    }
  }, 10_000).unref?.();
}

function stopScanner() {
  if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { startScanner, stopScanner, getStatus, getActivity, appendActivity, fetchTrendingTokens };
