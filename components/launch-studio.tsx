'use client';
import dynamic from 'next/dynamic';

// Keep all wallet adapters, hooks and transaction code out of server rendering.
const LaunchWallet = dynamic(
  () => import('@/components/launch-wallet').then(module => module.LaunchWallet),
  { ssr: false, loading: () => <output className="launch-notice">Loading local wallet review…</output> },
);

export function LaunchStudio() {
  return <LaunchWallet />;
}
