import type { Metadata } from 'next';
import { cast, show } from '@/lib/show';
import './globals.css';
/**
 * Link previews need absolute URLs. Without a metadataBase the framework resolves '/logo.png'
 * against its dev-server default and ships http://localhost:3000/... to every crawler, so the
 * card renders with no artwork — on a launch whose whole distribution is pasted links, that is
 * the first thing every prospective viewer sees. SITE_URL overrides it when a real domain
 * replaces the workers.dev one.
 */
const site = process.env.SITE_URL ?? 'https://interdimensional-podcast.leonardo-chekup.workers.dev';
export const metadata: Metadata = {
  metadataBase: new URL(site),
  title: `${show.name} | ${cast.host.name} and ${cast.guest.name}`,
  description: show.description,
  // The 431 KB logo was serving as the favicon on every tab load; the SVG is 712 bytes.
  // apple-touch-icon has no SVG support, so that one keeps the raster.
  icons: { icon: '/favicon.svg', apple: '/logo.png' },
  openGraph: {
    type: 'website',
    siteName: show.name,
    title: show.name,
    description: show.strap,
    url: '/',
    // 1200x630, both hosts on camera. The square logo is the wrong shape here: a
    // summary_large_image card crops it, and the point of the card is the cast.
    images: [{ url: '/share-card.png', width: 1200, height: 630, alt: show.name }],
  },
  twitter: {
    card: 'summary_large_image',
    title: show.name,
    description: show.strap,
    images: ['/share-card.png'],
  },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
