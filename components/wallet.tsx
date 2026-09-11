'use client';
import '@solana/wallet-adapter-react-ui/styles.css';
import { useMemo, type ReactNode } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
// The Buffer global that @solana/web3.js expects is injected for the client bundle in vite.config.ts.

// Hoisted: a fresh object here would defeat ConnectionProvider's memo and rebuild the
// web3.js Connection on every parent render, which is every poll tick.
const connectionConfig = { commitment: 'confirmed' } as const;
/**
 * The wallet layer, mounted only at the payment step so the rest of the site stays free of
 * wallet code. Phantom and Solflare are listed; Backpack and every other Wallet Standard
 * wallet are detected on their own.
 *
 * `autoConnect` is what makes choosing a wallet connect it. Without it the provider only
 * *selects* the wallet the viewer clicked: the button quietly turns into "Connect" and waits
 * for a second click nobody expects, which reads as a checkout where nothing happens. With
 * it, a click on Phantom opens Phantom. On a later visit it reconnects only silently, and
 * only to a wallet that already trusts this site, so nothing pops up uninvited.
 */
export function WalletShell({
  endpoint,
  children,
}: {
  endpoint: string;
  children: ReactNode;
}) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );
  return (
    <ConnectionProvider endpoint={endpoint} config={connectionConfig}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
