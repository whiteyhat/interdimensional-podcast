// Who a request is from, and how often they may ask. Shared by the routes that gate on it so
// the trust policy -- which proxy headers are allowed to name a caller -- is written down once.
/**
 * The caller's address, trusting only the header Cloudflare sets in front of the Worker.
 *
 * x-forwarded-for is honoured only for a request that arrived at localhost (wrangler dev and
 * the tests). In production it is whatever the client wrote, and a caller who can choose its
 * own bucket has no limit at all: it rotates the header and mints a fresh allowance each time.
 *
 * An IPv6 caller is keyed on its /64. Providers hand out at least that much per customer, so
 * rotating inside it is free, and keying on the full address would hand out 2^64 buckets.
 */
export function clientAddress(request: Request) {
  const cf = request.headers.get('cf-connecting-ip')?.trim();
  if (cf) return prefix(cf);
  let host = '';
  try {
    host = new URL(request.url).hostname;
  } catch {}
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0].trim();
    return forwarded ? prefix(forwarded) : 'local';
  }
  return 'unknown';
}
function prefix(ip: string) {
  if (!ip.includes(':')) return ip;
  // The first four hextets of the expanded form; "::" collapses, so expand what we have.
  const parts = ip.split('::');
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts[1] ? parts[1].split(':') : [];
  const missing = Math.max(0, 8 - head.length - tail.length);
  const full = [...head, ...Array(parts.length > 1 ? missing : 0).fill('0'), ...tail];
  return `${full.slice(0, 4).join(':')}::/64`;
}
/**
 * Spend `units` against a Cloudflare rate-limit binding. The binding counts one per call, so
 * an expensive request is charged by asking it that many times, in parallel; it is refused if
 * any one of those is. Over-charging a caller that is about to be refused anyway is fine.
 *
 * A missing binding (a deploy without it, or a test) allows everything and says so once, so
 * the proxy degrades to the database ceiling rather than to nothing.
 */
const warned = new Set<string>();
export async function charge(
  limiter: RateLimit | undefined,
  name: string,
  key: string,
  units: number,
): Promise<boolean> {
  if (!limiter) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[throttle] no ${name} binding; per-caller limit is off`);
    }
    return true;
  }
  const outcomes = await Promise.all(
    Array.from({ length: Math.max(1, units) }, () => limiter.limit({ key })),
  );
  return outcomes.every((o) => o.success);
}
/**
 * A sliding one-minute counter, per caller, in this isolate only.
 *
 * It does not hold: 200 anonymous POSTs from one address in 14 seconds went through with none
 * refused, because a colo runs many isolates and each one counted alone. It stays as a cheap
 * first gate on paths that also count in the database, and nothing should rely on it.
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
