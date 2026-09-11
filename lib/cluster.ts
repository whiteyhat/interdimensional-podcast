// Which Solana cluster a deployment settles on, read from its RPC URL. A local validator counts
// as devnet: both are test money, and neither may get mainnet prices, links or charts.
export type Cluster = 'mainnet-beta' | 'devnet';
const word = (name: string, text: string) =>
  new RegExp(`(^|[^a-z])${name}([^a-z]|$)`).test(text);
export function clusterOf(rpcUrl?: string): Cluster {
  let where: string;
  try {
    const url = new URL(rpcUrl?.trim() || '');
    // Host and path only: an API key in the query string can spell anything, "devnet"
    // included, and a mainnet RPC must never unlock test prices by accident.
    where = `${url.hostname}${url.pathname}`.toLowerCase();
  } catch {
    return 'mainnet-beta';
  }
  if (word('mainnet', where)) return 'mainnet-beta';
  return word('devnet', where) ||
    /^(localhost|127\.0\.0\.1|\[::1\])(\/|$)/.test(where)
    ? 'devnet'
    : 'mainnet-beta';
}
/** A transaction on the explorer, on the cluster it settled on. */
export const explorerTx = (signature: string, cluster: Cluster) =>
  `https://solscan.io/tx/${encodeURIComponent(signature)}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
