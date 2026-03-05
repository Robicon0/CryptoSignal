'use strict';

const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

const BQ_URL      = 'https://streaming.bitquery.io/graphql';
const MORALIS_URL = 'https://deep-index.moralis.io/api/v2.2';
const DATA_DIR    = path.join(__dirname, 'data');
const SCORE_FILE  = path.join(DATA_DIR, 'wallet_scores.json');
const SCORE_TTL   = 24 * 60 * 60 * 1000; // 24h cache

// ─────────────────────────────────────────────
// 402 sentinel error
// ─────────────────────────────────────────────
class Bq402Error extends Error {
  constructor() { super('Bitquery quota exceeded (402)'); this.name = 'Bq402Error'; }
}

// ─────────────────────────────────────────────
// Core query runner
// ─────────────────────────────────────────────
async function bqQuery(query, apiKey) {
  const r = await fetch(BQ_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body:    JSON.stringify({ query }),
    timeout: 20000,
  });
  if (r.status === 402) throw new Bq402Error();
  if (!r.ok) throw new Error(`Bitquery HTTP ${r.status}`);
  const d = await r.json();
  if (d.errors?.length) throw new Error(d.errors[0]?.message || 'Bitquery error');
  return d.data;
}

// ─────────────────────────────────────────────
// Wallet score cache (24h TTL)
// ─────────────────────────────────────────────
function loadScores() {
  if (!fs.existsSync(SCORE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SCORE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveScores(scores) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SCORE_FILE, JSON.stringify(scores, null, 2));
}

function getCachedScore(address) {
  const scores = loadScores();
  const entry  = scores[address];
  if (!entry) return null;
  if (Date.now() - new Date(entry.scoredAt).getTime() > SCORE_TTL) return null;
  return entry;
}

function setCachedScore(address, score) {
  const scores = loadScores();
  scores[address] = { ...score, scoredAt: new Date().toISOString() };
  // Keep cache bounded to 2000 entries
  const keys = Object.keys(scores);
  if (keys.length > 2000) {
    const oldest = keys.sort((a, b) =>
      new Date(scores[a].scoredAt) - new Date(scores[b].scoredAt)
    ).slice(0, 500);
    oldest.forEach(k => delete scores[k]);
  }
  saveScores(scores);
}

// ─────────────────────────────────────────────
// Fetch early buyers for a Solana token
// ─────────────────────────────────────────────
async function fetchEarlyBuyers(tokenAddress, apiKey, limit = 20) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10) + 'T00:00:00Z';

  const query = `{
    Solana {
      DEXTradeByTokens(
        where: {
          Trade: { Currency: { MintAddress: { is: "${tokenAddress}" } } Price: { gt: 0 } }
          Transaction: { Result: { Success: true } }
          Block: { Time: { since: "${since}" } }
        }
        orderBy: { ascending: Block_Time }
        limit: { count: ${limit} }
      ) {
        Block { Time }
        Trade { Account { Address } Currency { Symbol MintAddress } PriceInUSD }
        Transaction { Signature Signer }
      }
    }
  }`;

  const data = await bqQuery(query, apiKey);
  const raw  = data?.Solana?.DEXTradeByTokens || [];

  const seen   = new Set();
  const buyers = [];
  for (const t of raw) {
    const addr = t.Transaction?.Signer || t.Trade?.Account?.Address;
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    buyers.push({
      address:       addr,
      firstBuyTime:  t.Block?.Time,
      firstBuyPrice: t.Trade?.PriceInUSD,
      txId:          t.Transaction?.Signature,
    });
  }
  return buyers;
}

// ─────────────────────────────────────────────
// Moralis fallback: score wallet via Solana swap history
// ─────────────────────────────────────────────
async function moralisScoreWallet(address, moralisKey, minTrades = 3) {
  const url = `${MORALIS_URL}/${address}/swaps?chain=solana&order=DESC&limit=100`;
  const r = await fetch(url, {
    headers: { 'X-API-Key': moralisKey, 'Accept': 'application/json' },
    timeout: 15000,
  });
  if (!r.ok) throw new Error(`Moralis HTTP ${r.status}`);
  const data = await r.json();
  const swaps = Array.isArray(data?.result) ? data.result : [];

  // Group buys by token (bought = tokenOut != SOL/USDC)
  const SOL_MINTS = new Set([
    'So11111111111111111111111111111111111111112',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  ]);

  const tokenMap = new Map();
  for (const swap of swaps) {
    const bought = swap.tokenOut;
    const sold   = swap.tokenIn;
    if (!bought || SOL_MINTS.has(bought.address)) continue;

    const mint  = bought.address;
    const price = parseFloat(swap.usdValue || 0) / parseFloat(bought.amount || 1);
    if (!mint || price <= 0) continue;

    if (!tokenMap.has(mint)) {
      tokenMap.set(mint, { symbol: bought.symbol || mint.slice(0, 6), prices: [] });
    }
    tokenMap.get(mint).prices.push(price);
  }

  const uniqueTokens = tokenMap.size;
  if (uniqueTokens < minTrades) {
    return { winRate: null, total: uniqueTokens, wins: 0, losses: 0 };
  }

  const { fetchPrices } = require('./priceFetcher');
  const addresses = [...tokenMap.keys()].slice(0, 30);
  const priceMap  = await fetchPrices(addresses);

  let wins = 0, losses = 0, scored = 0;
  for (const [mint, pos] of tokenMap) {
    const avgBuy  = pos.prices.reduce((a, b) => a + b, 0) / pos.prices.length;
    const current = priceMap.get(mint);
    if (!current || current <= 0) continue;
    scored++;
    if (current > avgBuy) wins++; else losses++;
  }

  if (scored < minTrades) return { winRate: null, total: scored, wins, losses };

  return {
    winRate: Math.round((wins / scored) * 100),
    total:   scored,
    wins,
    losses,
  };
}

// ─────────────────────────────────────────────
// Score a wallet's win rate (cache-aware, Moralis fallback on 402)
// ─────────────────────────────────────────────
async function scoreWallet(address, apiKey, minTrades = 3, moralisKey = null) {
  // Return cached result if fresh
  const cached = getCachedScore(address);
  if (cached) return cached;

  let result;

  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10) + 'T00:00:00Z';

    const query = `{
      Solana {
        DEXTradeByTokens(
          where: {
            Transaction: { Signer: { is: "${address}" } }
            Block: { Time: { since: "${since}" } }
            Trade: { Price: { gt: 0 } }
          }
          orderBy: { ascending: Block_Time }
          limit: { count: 200 }
        ) {
          Block { Time }
          Trade { Currency { Symbol MintAddress } PriceInUSD Amount }
          Transaction { Signature }
        }
      }
    }`;

    const data   = await bqQuery(query, apiKey);
    const trades = data?.Solana?.DEXTradeByTokens || [];

    // Group by token mint, track avg traded price
    const tokenMap = new Map();
    for (const t of trades) {
      const mint  = t.Trade?.Currency?.MintAddress;
      const price = parseFloat(t.Trade?.PriceInUSD || 0);
      if (!mint || price <= 0) continue;
      if (!tokenMap.has(mint)) {
        tokenMap.set(mint, {
          symbol: t.Trade?.Currency?.Symbol || mint.slice(0, 6),
          prices: [],
        });
      }
      tokenMap.get(mint).prices.push(price);
    }

    const uniqueTokens = tokenMap.size;
    if (uniqueTokens < minTrades) {
      result = { winRate: null, total: uniqueTokens, wins: 0, losses: 0 };
    } else {
      const { fetchPrices } = require('./priceFetcher');
      const addresses = [...tokenMap.keys()].slice(0, 30);
      const priceMap  = await fetchPrices(addresses);

      let wins = 0, losses = 0, scored = 0;
      for (const [mint, pos] of tokenMap) {
        const avgBuy   = pos.prices.reduce((a, b) => a + b, 0) / pos.prices.length;
        const current  = priceMap.get(mint);
        if (!current || current <= 0) continue;
        scored++;
        if (current > avgBuy) wins++; else losses++;
      }

      if (scored < minTrades) {
        result = { winRate: null, total: scored, wins, losses };
      } else {
        result = {
          winRate: Math.round((wins / scored) * 100),
          total:   scored,
          wins,
          losses,
        };
      }
    }

  } catch (err) {
    if (err instanceof Bq402Error && moralisKey) {
      console.warn(`[Bitquery] 402 quota exceeded — falling back to Moralis for ${address.slice(0, 8)}`);
      result = await moralisScoreWallet(address, moralisKey, minTrades);
    } else {
      throw err;
    }
  }

  setCachedScore(address, result);
  return result;
}

module.exports = { fetchEarlyBuyers, scoreWallet, moralisScoreWallet, Bq402Error };
