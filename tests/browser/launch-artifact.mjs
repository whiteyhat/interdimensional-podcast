// Deliberately substituted only by launch-serve.mjs. Core transaction validation has
// its own tests; this fixture controls latency and rejection at the UI boundary.
export async function reviewPrepared(raw, connection) {
  return window.launchHarness.review(raw, connection);
}
export function makeSignedEnvelope(artifact, transaction) {
  return window.launchHarness.envelope(artifact, transaction);
}
