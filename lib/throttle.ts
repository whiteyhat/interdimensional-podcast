// Who a request is from, and how often they may ask. Shared by the routes that gate on it so
// the trust policy — which proxy headers are allowed to name a caller — is written down once.
/** The caller's address, trusting only the headers Cloudflare sets in front of the Worker. */
export function clientAddress(request: Request) {
  return (
    request.headers.get('cf-connecting-ip')?.trim() ||
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    'local'
  );
}
/**
 * A sliding one-minute counter, per caller. Each route gets its own bucket: a burst of RPC
 * calls must not eat somebody's quote allowance.
 *
 * This map lives in one isolate and a colo runs many, so it is a best-effort first gate. The
 * limit that actually holds across isolates is whatever the route counts in the database.
 */
export function perMinuteCounter() {
  const seen = new Map<string, number[]>();
  return function tooMany(key: string, limit: number, now: number) {
    const recent = (seen.get(key) ?? []).filter((t) => now - t < 60_000);
    // Only record while under the limit. Pushing on every attempt lets one abusive caller grow
    // its own array without bound, and the filter above then re-walks it on every request.
    if (recent.length >= limit) {
      seen.set(key, recent);
      return true;
    }
    recent.push(now);
    seen.set(key, recent);
    if (seen.size > 5000) seen.clear();
    return false;
  };
}
