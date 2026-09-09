import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { LaunchStudio } from '@/components/launch-studio';
import '../../launch.css';

export const dynamic = 'force-dynamic';

export default async function LaunchPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  const requestHeaders = await headers();
  const host = requestHeaders.get('host');
  // Parse only the actual Host header. Forwarded headers cannot grant local access,
  // and credentials, paths, suffixes and alternate numeric IP forms are rejected.
  if (!host || !/^(localhost|127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?$/i.test(host)) notFound();
  try {
    const origin = new URL(`http://${host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) notFound();
  } catch {
    notFound();
  }
  return (
    <main className="launch-page">
      <nav className="launch-nav" aria-label="Launch navigation"><Link href="/studio">← Back to the studio</Link><Link href="/allocations">Public allocations ↗</Link></nav>
      <div className="launch-page-heading"><p className="launch-kicker">LOCAL STUDIO / SIGN ONLY</p><h1>Review the launch</h1><p>Import the prepared transaction, check its addresses and maximum budget, then sign with the creator wallet. This page downloads a signed file. The CLI submit command broadcasts it.</p></div>
      <LaunchStudio />
    </main>
  );
}
