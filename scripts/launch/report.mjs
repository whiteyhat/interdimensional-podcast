import { PublicKey } from '@solana/web3.js';
import { DISCLOSURE, tokenUnits } from '../../lib/launch/config.mjs';
export const HISTORY_LIMIT = 20;
export function publicSnapshot(config, observed, generatedAt = new Date().toISOString()) {
  const errors = [];
  const wallets = config.wallets.map(w => {
    const found = observed.wallets.find(x => x.address === w.address);
    if (found?.error) errors.push({ address: w.address, message: found.error });
    const balanceBase = found?.balanceBase ?? null;
    const supply = observed.totalSupplyBase;
    return { address: w.address, label: w.label, purpose: w.purpose, plannedTokens: w.plannedTokens, maySell: w.maySell,
      balanceBase, balanceTokens: balanceBase === null ? null : tokenUnits(balanceBase, observed.decimals),
      supplyPercent: balanceBase !== null && supply && BigInt(supply) > 0n ? tokenUnits((BigInt(balanceBase) * 1000000n / BigInt(supply)).toString(), 4) : null,
      transactions: (found?.transactions ?? []).map(t => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime ?? null, status: t.status })) };
  });
  return { schemaVersion: 1, generatedAt, network: config.network, mint: observed.mint, name: config.name, symbol: config.symbol, disclosure: DISCLOSURE,
    totalSupplyBase: observed.totalSupplyBase, decimals: observed.decimals, historyLimit: HISTORY_LIMIT, commitment: 'finalized', complete: errors.length === 0, errors, wallets };
}
export async function collectReport(config, state, connection, metadataUri) {
  const { verifyMint } = await import('./chain.mjs');
  const verified = await verifyMint(config, state, connection, metadataUri);
  const wallets = [];
  // Bound RPC concurrency: the register is small and reports run only on demand.
  for (const wallet of config.wallets) {
    try {
      const owner = new PublicKey(wallet.address);
      const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: verified.mint }, 'finalized');
      let amount = 0n;
      for (const { account } of accounts.value) {
        const info = account.data.parsed.info;
        if (info.mint !== state.mint || info.owner !== wallet.address) throw new Error('Unexpected token account.');
        amount += BigInt(info.tokenAmount.amount);
      }
      const sources = [owner, ...accounts.value.map(a => a.pubkey)];
      const history = new Map();
      for (const account of sources) {
        const rows = await connection.getSignaturesForAddress(account, { limit: HISTORY_LIMIT }, 'finalized');
        for (const t of rows) history.set(t.signature, { signature: t.signature, slot: t.slot, blockTime: t.blockTime, status: t.err ? 'failed' : 'finalized' });
      }
      wallets.push({ address: wallet.address, balanceBase: amount.toString(), transactions: [...history.values()].sort((a,b) => b.slot - a.slot).slice(0, HISTORY_LIMIT) });
    } catch { wallets.push({ address: wallet.address, balanceBase: null, transactions: [], error: 'Wallet RPC data is unavailable for this snapshot.' }); }
  }
  return publicSnapshot(config, { mint: state.mint, decimals: verified.decimals, totalSupplyBase: verified.supply.toString(), wallets });
}
