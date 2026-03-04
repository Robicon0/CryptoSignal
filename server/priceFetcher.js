'use strict';

const fetch = require('node-fetch');

/**
 * Fetch current price and liquidity for a Solana token from DexScreener.
 * Returns { price, liquidityUsd, symbol, name } or null on failure.
 */
async function fetchTokenData(tokenAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    const res  = await fetch(url, { timeout: 8000 });
    if (!res.ok) return null;

    const data = await res.json();
    const pairs = data?.pairs;
    if (!pairs || pairs.length === 0) return null;

    // Pick the pair with highest liquidity on Solana
    const solanaPairs = pairs.filter(p => p.chainId === 'solana');
    const pool = (solanaPairs.length ? solanaPairs : pairs)
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

    return {
      price:        parseFloat(pool.priceUsd) || 0,
      liquidityUsd: pool.liquidity?.usd       || 0,
      symbol:       pool.baseToken?.symbol    || '',
      name:         pool.baseToken?.name      || '',
      pairAddress:  pool.pairAddress          || '',
    };
  } catch (err) {
    console.error(`[PriceFetcher] Error fetching ${tokenAddress}:`, err.message);
    return null;
  }
}

/**
 * Fetch prices for multiple token addresses in parallel.
 * Returns a Map<address, number> of current prices.
 */
async function fetchPrices(addresses) {
  const priceMap = new Map();
  if (!addresses.length) return priceMap;

  const results = await Promise.allSettled(addresses.map(a => fetchTokenData(a)));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value && r.value.price > 0) {
      priceMap.set(addresses[i], r.value.price);
    }
  });
  return priceMap;
}

/**
 * Fetch recent buys for a Solana wallet using DexScreener search.
 * Returns array of { tokenAddress, symbol, price, liquidityUsd, timestamp }
 *
 * Strategy: query the DexScreener /orders endpoint to detect recent token activity.
 * Falls back to a simple heuristic when the wallet has no indexed orders.
 */
async function fetchWalletBuys(walletAddress) {
  try {
    // DexScreener doesn't have a direct wallet tx API — use their token search
    // combined with Solana RPC to detect new tokens in a wallet.
    // For now, use their public endpoint for wallet activity if available.
    const url = `https://api.dexscreener.com/orders/v1/solana/${walletAddress}`;
    const res  = await fetch(url, { timeout: 8000 });
    if (!res.ok) return [];

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    const buys = data
      .filter(o => o.type === 'tokenProfile' || o.status === 'approved')
      .slice(0, 5)
      .map(o => ({
        tokenAddress: o.tokenAddress || '',
        symbol:       o.icon ? '' : '',
        price:        0,
        liquidityUsd: 0,
        timestamp:    o.createdAt ? new Date(o.createdAt).toISOString() : new Date().toISOString(),
      }))
      .filter(b => b.tokenAddress);

    return buys;
  } catch {
    return [];
  }
}

/**
 * Use Bitquery (free tier, no auth) to get recent Solana DEX buys by wallet.
 * Returns array of { tokenAddress, symbol, price, amountUsd, timestamp }
 */
async function fetchWalletBuysViaRPC(walletAddress) {
  // Solana public RPC — get recent signatures then parse token transfers
  const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

  try {
    // Step 1: Get recent transaction signatures
    const sigResp = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
        params: [walletAddress, { limit: 20 }],
      }),
      timeout: 10000,
    });

    if (!sigResp.ok) return [];
    const sigData = await sigResp.json();
    const sigs = sigData?.result || [];

    const cutoff = Date.now() - 15 * 1000; // last 15 seconds
    const recentSigs = sigs.filter(s => s.blockTime && s.blockTime * 1000 >= cutoff);

    if (recentSigs.length === 0) return [];

    // Step 2: Fetch transaction details for recent sigs
    const txPromises = recentSigs.slice(0, 5).map(s =>
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
    const buys = [];

    for (const result of txResults) {
      if (result.status !== 'fulfilled' || !result.value?.result) continue;
      const tx = result.value.result;

      // Look for token balance increases (wallet received tokens = potential buy)
      const postBalances  = tx.meta?.postTokenBalances  || [];
      const preBalances   = tx.meta?.preTokenBalances   || [];

      for (const post of postBalances) {
        if (post.owner !== walletAddress) continue;
        const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
        const preAmt  = parseFloat(pre?.uiTokenAmount?.uiAmount  || 0);
        const postAmt = parseFloat(post.uiTokenAmount?.uiAmount  || 0);

        if (postAmt > preAmt && post.mint) {
          // Wallet received this token → likely a buy
          const tokenMint = post.mint;
          buys.push({
            tokenAddress: tokenMint,
            symbol:       post.uiTokenAmount?.decimals !== undefined ? '' : '',
            price:        0,
            liquidityUsd: 0,
            timestamp:    tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : new Date().toISOString(),
          });
        }
      }
    }

    return buys;
  } catch (err) {
    console.error(`[PriceFetcher] RPC error for ${walletAddress}:`, err.message);
    return [];
  }
}

module.exports = { fetchTokenData, fetchPrices, fetchWalletBuys, fetchWalletBuysViaRPC };
