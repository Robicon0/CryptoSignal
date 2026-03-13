'use strict';

const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

const BQ_URL      = 'https://streaming.bitquery.io/graphql';
// Solana-specific Moralis gateway (deep-index is EVM only)
const MORALIS_SOL = 'https://solana-gateway.moralis.io';
const DATA_DIR    = path.join(__dirname, 'data');
const SCORE_FILE  = path.join(DATA_DIR, 'wallet_scores.json');
const SCORE_TTL   = 24 * 60 * 60 * 1000; // 24h cache

// SOL / stablecoin mints to ignore when identifying "bought" tokens
const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',  // SOL/WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

// ─────────────────────────────────────────────
// 402 sentinel error
// ─────────────────────────────────────────────
class Bq402Error extends Error {
  constructor() { super('Bitquery quota exceeded (402)'); this.name = 'Bq402Error'; }
}

// ─────────────────────────────────────────────
// Core Bitquery runner
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
// Moralis helpers
// ─────────────────────────────────────────────
async function moralisFetch(url, moralisKey) {
  const r = await fetch(url, {
    headers: { 'X-API-Key': moralisKey, 'Accept': 'application/json' },
    timeout: 15000,
  });
  // 404 = wallet/token not indexed by Moralis — treat as empty, not an error
  if (r.status === 404) return { result: [] };
  if (!r.ok) throw new Error(`Moralis HTTP ${r.status}`);
  return r.json();
}

// ─────────────────────────────────────────────
// STRATEGY 1 — Bitquery: fetch early buyers of a token
// ─────────────────────────────────────────────
async function fetchEarlyBuyersBq(tokenAddress, apiKey, limit = 20) {
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
// STRATEGY 2 — Moralis: fetch early buyers of a token
// ─────────────────────────────────────────────
async function fetchEarlyBuyersMoralis(tokenAddress, moralisKey, limit = 20) {
  // Correct Solana endpoint: solana-gateway.moralis.io/token/mainnet/{address}/swaps
  const url = `${MORALIS_SOL}/token/mainnet/${tokenAddress}/swaps?order=ASC&limit=${limit}`;
  console.log(`[Bitquery→Moralis] Fetching early buyers for ${tokenAddress.slice(0, 8)} via Moralis`);

  const data  = await moralisFetch(url, moralisKey);
  const swaps = Array.isArray(data?.result) ? data.result : [];

  const seen   = new Set();
  const buyers = [];
  for (const s of swaps) {
    // Moralis field: walletAddress or Transaction.from
    const addr = s.walletAddress || s.from;
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    buyers.push({
      address:       addr,
      firstBuyTime:  s.blockTimestamp,
      firstBuyPrice: null,
      txId:          s.transactionHash,
    });
  }
  console.log(`[Bitquery→Moralis] Found ${buyers.length} buyers for ${tokenAddress.slice(0, 8)}`);
  return buyers;
}

// ─────────────────────────────────────────────
// STRATEGY 3 — Solana RPC: fetch early buyers of a token
// KEY INSIGHT: call getSignaturesForAddress on the POOL/PAIR address
// (from DexScreener), NOT the token mint address. The pool is a writable
// account in every swap, so its signature list = swap transactions.
// Using token mint only works for pump.fun tokens by coincidence.
// Public RPC prunes ~80% of older txs — fetch 100 sigs, check 50.
// ─────────────────────────────────────────────
async function fetchEarlyBuyersRPC(tokenAddress, limit = 20, pairAddress = null) {
  // DexScreener's pairAddress is their internal ID, not always a real on-chain account.
  // Try token mint first (works for pump.fun bonding curves), then pair address.
  const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

  async function getSigs(addr) {
    try {
      const r = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [addr, { limit: 100 }] }),
        timeout: 12000,
      });
      if (!r.ok) return [];
      const d = await r.json();
      return d?.result || [];
    } catch { return []; }
  }

  let sigs = await getSigs(tokenAddress);
  let addrType = 'mint';

  if (!sigs.length && pairAddress) {
    console.log(`[RPC] 0 sigs via mint, trying pair address for ${tokenAddress.slice(0, 8)}`);
    const pairSigs = await getSigs(pairAddress);
    if (pairSigs.length) { sigs = pairSigs; addrType = 'pair'; }
  }

  console.log(`[RPC] ${sigs.length} sigs for ${tokenAddress.slice(0, 8)} via ${addrType}`);
  if (!sigs.length) return [];

  try {
    // Fetch up to 50 tx details in parallel (more = better odds of non-null results)
    const txPromises = sigs.slice(0, 50).map(s =>
      fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getTransaction',
          params: [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        }),
        timeout: 8000,
      }).then(r => r.json()).catch(() => null)
    );

    const txResults = await Promise.allSettled(txPromises);
    const seen    = new Set();
    const buyers  = [];
    let nullCount = 0;

    for (const result of txResults) {
      if (result.status !== 'fulfilled' || !result.value?.result) { nullCount++; continue; }
      const tx = result.value.result;

      // Fee payer (account index 0) initiated the swap = the buyer
      const signer = tx.transaction?.message?.accountKeys?.[0]?.pubkey;
      if (!signer || seen.has(signer) || QUOTE_MINTS.has(signer)) continue;

      // Confirm the fee payer's ATA balance INCREASED for this token (buy not sell)
      const postBalances = tx.meta?.postTokenBalances || [];
      const preBalances  = tx.meta?.preTokenBalances  || [];
      const receivedToken = postBalances.some(post => {
        if (post.mint !== tokenAddress) return false;
        if (post.owner !== signer) return false;
        const pre     = preBalances.find(p => p.accountIndex === post.accountIndex);
        const preAmt  = parseFloat(pre?.uiTokenAmount?.uiAmount  || 0);
        const postAmt = parseFloat(post.uiTokenAmount?.uiAmount || 0);
        return postAmt > preAmt;
      });

      if (!receivedToken) continue;
      seen.add(signer);
      buyers.push({
        address:       signer,
        firstBuyTime:  tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
        firstBuyPrice: null,
        txId:          sigs[0]?.signature,
      });

      if (buyers.length >= limit) break;
    }

    console.log(`[RPC] ${buyers.length} buyers found for ${tokenAddress.slice(0, 8)} (${nullCount}/${txResults.length} txs null/pruned)`);
    return buyers;
  } catch (err) {
    console.error(`[RPC] Error for ${tokenAddress.slice(0, 8)}: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────
// Public: fetchEarlyBuyers — chains all three strategies
// pairAddress from scanner (DexScreener) is threaded through to RPC
// so we don't need a second DexScreener call inside fetchEarlyBuyersRPC
// ─────────────────────────────────────────────
async function fetchEarlyBuyers(tokenAddress, apiKey, limit = 20, moralisKey = null, pairAddress = null) {
  // Strategy 1: Bitquery (skip entirely if no key — avoids 401 masking the fallbacks)
  if (apiKey) {
    try {
      return await fetchEarlyBuyersBq(tokenAddress, apiKey, limit);
    } catch (err) {
      // Fall through on both 402 (quota) and any other Bitquery error
      console.warn(`[Bitquery] fetchEarlyBuyers failed (${err.message}) — trying Moralis`);
    }
  }

  // Strategy 2: Moralis
  if (moralisKey) {
    try {
      const buyers = await fetchEarlyBuyersMoralis(tokenAddress, moralisKey, limit);
      if (buyers.length > 0) return buyers;
      console.warn(`[Moralis] 0 results for ${tokenAddress.slice(0, 8)} — trying RPC`);
    } catch (err) {
      console.warn(`[Moralis] failed for ${tokenAddress.slice(0, 8)}: ${err.message} — trying RPC`);
    }
  }

  // Strategy 3: Solana RPC (no API key needed, pairAddress avoids extra DexScreener call)
  return fetchEarlyBuyersRPC(tokenAddress, limit, pairAddress);
}

// ─────────────────────────────────────────────
// SCORING STRATEGY 2 — Moralis wallet swap history
// Fixed: correct URL (/wallets/{address}/swaps) and field names
// ─────────────────────────────────────────────
async function moralisScoreWallet(address, moralisKey, minTrades = 3) {
  // Correct Solana endpoint: solana-gateway.moralis.io/account/mainnet/{address}/swaps
  const url = `${MORALIS_SOL}/account/mainnet/${address}/swaps?order=DESC&limit=100`;
  console.log(`[Moralis] Scoring wallet ${address.slice(0, 8)}`);

  const data  = await moralisFetch(url, moralisKey);
  const swaps = Array.isArray(data?.result) ? data.result : [];
  console.log(`[Moralis] Got ${swaps.length} swaps for ${address.slice(0, 8)}`);

  // Build a map of token → buy prices
  // Solana gateway field names: tokenIn, tokenOut (with .address, .symbol, .amount, .amountUsd)
  const tokenMap = new Map();
  for (const swap of swaps) {
    // tokenOut = what was bought; tokenIn = what was spent (SOL/USDC)
    const tokenOut = swap.tokenOut;
    if (!tokenOut) continue;

    const mint = tokenOut.address;
    if (!mint || QUOTE_MINTS.has(mint)) continue;

    // Price per token in USD from Moralis Solana gateway
    const usdSpent  = parseFloat(swap.tokenIn?.amountUsd  || swap.usdAmountIn || 0);
    const tokAmount = parseFloat(tokenOut.amount || 1);
    const price     = tokAmount > 0 ? usdSpent / tokAmount : 0;
    if (price <= 0) continue;

    if (!tokenMap.has(mint)) {
      tokenMap.set(mint, {
        symbol: tokenOut.symbol || tokenOut.name || mint.slice(0, 6),
        prices: [],
      });
    }
    tokenMap.get(mint).prices.push(price);
  }

  const uniqueTokens = tokenMap.size;
  console.log(`[Moralis] ${address.slice(0, 8)}: ${uniqueTokens} unique tokens found`);

  if (uniqueTokens < minTrades) {
    return { winRate: null, total: uniqueTokens, wins: 0, losses: 0, via: 'moralis' };
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

  if (scored < minTrades) return { winRate: null, total: scored, wins, losses, via: 'moralis' };
  return {
    winRate: Math.round((wins / scored) * 100),
    total: scored, wins, losses, via: 'moralis',
  };
}

// ─────────────────────────────────────────────
// SCORING STRATEGY 3 — Solana RPC + DexScreener heuristic
// No API key needed. Checks recent token purchases via RPC,
// then scores each token by current DexScreener liquidity:
//   win  = token still has >$5K liquidity (survived/pumped)
//   loss = token has <$1K liquidity (likely rugged or dead)
// ─────────────────────────────────────────────
async function rpcScoreWallet(address, minTrades = 3) {
  const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  console.log(`[RPC] Scoring wallet ${address.slice(0, 8)} via Solana RPC + DexScreener`);

  try {

  // Get last 100 signatures
  const sigResp = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
      params: [address, { limit: 100 }],
    }),
    timeout: 10000,
  });
  if (!sigResp.ok) return { winRate: null, total: 0, wins: 0, losses: 0, via: 'rpc' };
  const { result: sigs } = await sigResp.json();
  if (!sigs?.length) return { winRate: null, total: 0, wins: 0, losses: 0, via: 'rpc' };

  // Fetch tx details for the 15 most recent (rate-limit friendly)
  const txPromises = sigs.slice(0, 15).map(s =>
    fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getTransaction',
        params: [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      }),
      timeout: 8000,
    }).then(r => r.json()).catch(() => null)
  );

  const txResults = await Promise.allSettled(txPromises);
  const tokenMints = new Set();

  for (const result of txResults) {
    if (result.status !== 'fulfilled' || !result.value?.result) continue;
    const tx = result.value.result;
    const postBalances = tx.meta?.postTokenBalances || [];
    const preBalances  = tx.meta?.preTokenBalances  || [];

    for (const post of postBalances) {
      if (post.owner !== address || !post.mint) continue;
      if (QUOTE_MINTS.has(post.mint)) continue;
      const pre    = preBalances.find(p => p.accountIndex === post.accountIndex);
      const preAmt = parseFloat(pre?.uiTokenAmount?.uiAmount  || 0);
      const postAmt= parseFloat(post.uiTokenAmount?.uiAmount || 0);
      if (postAmt > preAmt) tokenMints.add(post.mint);
    }
  }

  const uniqueTokens = tokenMints.size;
  console.log(`[RPC] ${address.slice(0, 8)}: ${uniqueTokens} token purchases found`);

  if (uniqueTokens < minTrades) {
    return { winRate: null, total: uniqueTokens, wins: 0, losses: 0, via: 'rpc' };
  }

  // Score by DexScreener liquidity heuristic
  const { fetchTokenData } = require('./priceFetcher');
  const addrs = [...tokenMints].slice(0, 15);

  let wins = 0, losses = 0, scored = 0;
  for (const mint of addrs) {
    try {
      const data = await fetchTokenData(mint);
      if (!data) continue;
      scored++;
      // Token still has meaningful liquidity = wallet's buy survived
      if (data.liquidityUsd >= 5000) wins++; else losses++;
    } catch { continue; }
  }

  if (scored < minTrades) return { winRate: null, total: scored, wins, losses, via: 'rpc' };
  return {
    winRate: Math.round((wins / scored) * 100),
    total: scored, wins, losses, via: 'rpc',
  };

  } catch (err) {
    console.warn(`[RPC] rpcScoreWallet error for ${address.slice(0, 8)}: ${err.message}`);
    return { winRate: null, total: 0, wins: 0, losses: 0, via: 'rpc' };
  }
}

// ─────────────────────────────────────────────
// Public: scoreWallet — chains Bitquery → Moralis → RPC
// ─────────────────────────────────────────────
async function scoreWallet(address, apiKey, minTrades = 3, moralisKey = null) {
  const cached = getCachedScore(address);
  if (cached) return cached;

  let result = null;

  // Strategy 1: Bitquery (skip if no key — avoids 401 errors masking the fallbacks)
  if (apiKey) {
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

      const tokenMap = new Map();
      for (const t of trades) {
        const mint  = t.Trade?.Currency?.MintAddress;
        const price = parseFloat(t.Trade?.PriceInUSD || 0);
        if (!mint || price <= 0) continue;
        if (!tokenMap.has(mint)) {
          tokenMap.set(mint, { symbol: t.Trade?.Currency?.Symbol || mint.slice(0, 6), prices: [] });
        }
        tokenMap.get(mint).prices.push(price);
      }

      const uniqueTokens = tokenMap.size;
      if (uniqueTokens < minTrades) {
        result = { winRate: null, total: uniqueTokens, wins: 0, losses: 0, via: 'bitquery' };
      } else {
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
        result = scored < minTrades
          ? { winRate: null, total: scored, wins, losses, via: 'bitquery' }
          : { winRate: Math.round((wins / scored) * 100), total: scored, wins, losses, via: 'bitquery' };
      }
    } catch (err) {
      // Fall through on any Bitquery error (402 quota, 401 invalid key, network, etc.)
      console.warn(`[Bitquery] scoreWallet failed (${err.message}) — trying Moralis`);
    }
  }

  // Strategy 2: Moralis (if Bitquery gave no result)
  if (!result && moralisKey) {
    try {
      result = await moralisScoreWallet(address, moralisKey, minTrades);
    } catch (err2) {
      console.warn(`[Moralis] scoreWallet failed: ${err2.message} — trying RPC`);
    }
  }

  // Strategy 3: RPC (if still no result)
  if (!result) {
    result = await rpcScoreWallet(address, minTrades); // never throws — has its own try/catch
  }

  setCachedScore(address, result);
  return result;
}

module.exports = {
  fetchEarlyBuyers,
  fetchEarlyBuyersBq,
  fetchEarlyBuyersMoralis,
  fetchEarlyBuyersRPC,
  scoreWallet,
  moralisScoreWallet,
  rpcScoreWallet,
  Bq402Error,
};
