// Run from a scheduler independently of the producer. Never prints credentials or receipt tokens.
const origin = process.env.SPONSOR_ORIGIN;
const token = process.env.SPONSOR_RECONCILE_TOKEN;
if (!origin || !token)
  throw new Error('Set SPONSOR_ORIGIN and SPONSOR_RECONCILE_TOKEN.');
const url = new URL('/api/sponsorship/reconcile', origin);
if (
  url.protocol !== 'https:' &&
  !['localhost', '127.0.0.1'].includes(url.hostname)
)
  throw new Error('Use HTTPS for the reconciler.');
async function reconcile() {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'x-reconcile-token': token },
    signal: AbortSignal.timeout(75000),
  });
  if (!response.ok) throw new Error(`Reconciler returned ${response.status}.`);
  console.log(JSON.stringify(await response.json()));
}
if (process.argv.includes('--watch')) {
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  while (!stopped) {
    try {
      await reconcile();
    } catch (e) {
      console.error(e instanceof Error ? e.message : 'Reconciliation failed.');
    }
    if (!stopped) await new Promise((resolve) => setTimeout(resolve, 20000));
  }
} else await reconcile();
