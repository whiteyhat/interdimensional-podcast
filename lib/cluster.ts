// Which Solana cluster a deployment settles on, read from its RPC URL. A local validator counts
// as devnet: both are test money, and neither may get mainnet prices, links or charts.
export type Cluster = 'mainnet-beta' | 'devnet';
export const clusterOf = (rpcUrl?: string): Cluster =>
  /devnet|localhost|127\.0\.0\.1/.test(rpcUrl?.trim() || '')
    ? 'devnet'
    : 'mainnet-beta';
/** A transaction on the explorer, on the cluster it settled on. */
export const explorerTx = (signature: string, cluster: Cluster) =>
  `https://solscan.io/tx/${encodeURIComponent(signature)}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
