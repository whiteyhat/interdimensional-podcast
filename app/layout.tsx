import type { Metadata } from 'next';
import { cast, show } from '@/lib/show';
import './globals.css';
export const metadata: Metadata = {
  title: `${show.name} | ${cast.host.name} and ${cast.guest.name}`,
  description: show.description,
  icons: { icon: '/logo.png', apple: '/logo.png' },
  openGraph: { title: show.name, description: show.strap, images: ['/logo.png'] },
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
