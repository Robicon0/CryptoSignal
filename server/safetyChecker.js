'use strict';

const fetch = require('node-fetch');

/**
 * Check a token against GoPlus Security API (free tier, no API key needed for basic checks).
 * Returns { safe: bool, reasons: string[] }
 */
async function checkTokenSafety(tokenAddress, chain = 'solana') {
  // GoPlus chain IDs: solana = 'solana', ethereum = '1', bsc = '56', etc.
  const chainId = chain === 'solana' ? 'solana' : chainToGoPlusId(chain);

  try {
    const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${tokenAddress}`;
    const res  = await fetch(url, { timeout: 8000 });

    if (!res.ok) {
      // GoPlus unavailable — fail open with a warning
      console.warn(`[Safety] GoPlus unavailable (${res.status}), skipping safety check`);
      return { safe: true, reasons: ['GoPlus check skipped (unavailable)'] };
    }

    const data = await res.json();
    const info = data?.result?.[tokenAddress.toLowerCase()] || data?.result?.[tokenAddress] || null;

    if (!info) {
      console.warn(`[Safety] No GoPlus data for ${tokenAddress}`);
      return { safe: true, reasons: ['No GoPlus data — proceeding with caution'] };
    }

    const reasons = [];

    if (info.is_honeypot === '1')      reasons.push('Honeypot detected');
    if (info.is_blacklisted === '1')   reasons.push('Token is blacklisted');
    if (info.is_whitelisted === '1')   { /* whitelisted = good */ }
    if (info.is_proxy === '1')         reasons.push('Proxy contract (risky)');
    if (info.is_mintable === '1')      reasons.push('Token is mintable (inflation risk)');
    if (info.can_take_back_ownership === '1') reasons.push('Owner can reclaim ownership');
    if (info.is_anti_whale === '1')    { /* anti-whale = usually fine */ }
    if (info.trading_cooldown === '1') reasons.push('Trading cooldown enabled');
    if (info.is_open_source === '0')   reasons.push('Contract is not open source');

    // Buy/sell tax checks
    const buyTax  = parseFloat(info.buy_tax  || 0);
    const sellTax = parseFloat(info.sell_tax || 0);
    if (buyTax > 10)  reasons.push(`High buy tax: ${buyTax}%`);
    if (sellTax > 10) reasons.push(`High sell tax: ${sellTax}%`);
    if (sellTax >= 100) reasons.push('Cannot sell — 100% sell tax');

    const HARD_FAILS = ['Honeypot detected', 'Cannot sell — 100% sell tax'];
    const safe = !reasons.some(r => HARD_FAILS.some(f => r.includes(f.split('—')[0].trim())));

    return { safe, reasons };

  } catch (err) {
    console.error(`[Safety] Error checking ${tokenAddress}:`, err.message);
    return { safe: true, reasons: ['Safety check error — proceeding with caution'] };
  }
}

/**
 * Check minimum liquidity from DexScreener data.
 */
function checkLiquidity(liquidityUsd, minLiquidityUsd = 5000) {
  if (liquidityUsd < minLiquidityUsd) {
    return { ok: false, reason: `Liquidity too low: $${liquidityUsd.toLocaleString()} (min $${minLiquidityUsd.toLocaleString()})` };
  }
  return { ok: true };
}

function chainToGoPlusId(chain) {
  const map = { ethereum: '1', bsc: '56', base: '8453', arbitrum: '42161', polygon: '137', avalanche: '43114' };
  return map[chain] || '1';
}

module.exports = { checkTokenSafety, checkLiquidity };
