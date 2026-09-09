'use client';
import { useEffect, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Transaction } from '@solana/web3.js';
import { WalletShell } from './wallet';
import { sponsorAction } from '@/lib/sponsor-browser';
import type {
  SponsorAsset,
  SponsorAttempt,
  SponsorReceipt,
} from '@/lib/sponsorship';

type Props = {
  receipt: SponsorReceipt;
  asset: SponsorAsset;
  endpoint: string;
  onReceipt: (receipt: SponsorReceipt) => void;
  onPending: (pending: boolean) => void;
};
export function SponsorWallet(props: Props) {
  const endpoint = new URL(props.endpoint, window.location.origin).href;
  return (
    <WalletShell endpoint={endpoint}>
      <Payment {...props} />
    </WalletShell>
  );
}
function Payment({ receipt, asset, onReceipt, onPending }: Props) {
  const { connection } = useConnection();
  const { publicKey, signTransaction, sendTransaction } = useWallet();
  const [quote, setQuote] = useState<{
    attempt: SponsorAttempt;
    transaction: string;
  } | null>(null);
  const [phase, setPhase] = useState<
    'idle' | 'quoting' | 'ready' | 'signing' | 'checking'
  >('idle');
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const pending = useRef(false);
  const mounted = useRef(true);
  const walletKey = publicKey?.toBase58();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!pending.current) {
      setQuote(null);
      setPhase('idle');
      setError('');
    }
  }, [walletKey, asset]);
  if (
    phase === 'checking' &&
    quote &&
    ['draft', 'payment-pending'].includes(receipt.status) &&
    receipt.paidAt === null &&
    receipt.attempts.some(
      (attempt) =>
        attempt.id === quote.attempt.id && attempt.status === 'expired',
    ) &&
    receipt.attempts.every((attempt) => attempt.status === 'expired')
  ) {
    // Only a reconciled receipt releases a possibly broadcast payment. The
    // quote timer alone cannot prove that funds did not land on Solana.
    setQuote(null);
    setPhase('idle');
    setError('');
  }
  async function review() {
    if (!walletKey || pending.current) return;
    pending.current = true;
    setPhase('quoting');
    setError('');
    try {
      const result = await sponsorAction({
        action: 'quote',
        token: receipt.token,
        asset,
        wallet: walletKey,
      });
      if (!mounted.current) return;
      if (result.receipt) onReceipt(result.receipt);
      if (!result.attempt || !result.transaction)
        throw Error('The payment quote is not ready.');
      setQuote({ attempt: result.attempt, transaction: result.transaction });
      setPhase('ready');
    } catch (e) {
      if (mounted.current) {
        setError(
          e instanceof Error ? e.message : 'The quote could not be prepared.',
        );
        setPhase('idle');
      }
    } finally {
      pending.current = false;
    }
  }
  async function check() {
    if (pending.current) return;
    pending.current = true;
    setError('');
    setPhase('checking');
    try {
      const result = await sponsorAction({
        action: 'confirm',
        token: receipt.token,
        attemptId: quote?.attempt.id,
      });
      if (result.receipt) onReceipt(result.receipt);
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error
            ? e.message
            : 'Confirmation is taking longer. Your receipt is saved.',
        );
    } finally {
      pending.current = false;
    }
  }
  async function pay() {
    if (
      !quote ||
      !walletKey ||
      pending.current ||
      now >= quote.attempt.expiresAt
    )
      return;
    pending.current = true;
    onPending(true);
    setPhase('signing');
    setError('');
    let mayHaveBroadcast = false;
    try {
      const bytes = Uint8Array.from(atob(quote.transaction), (c) =>
        c.charCodeAt(0),
      );
      const transaction = Transaction.from(bytes);
      if (signTransaction) {
        const signed = await signTransaction(transaction);
        const signedTx = btoa(String.fromCharCode(...signed.serialize()));
        mayHaveBroadcast = true;
        const result = await sponsorAction({
          action: 'submit',
          token: receipt.token,
          attemptId: quote.attempt.id,
          signedTx,
        });
        if (result.receipt) onReceipt(result.receipt);
      } else {
        // A wallet can broadcast before its promise resolves. Any exception here is ambiguous.
        mayHaveBroadcast = true;
        const signature = await sendTransaction(transaction, connection, {
          skipPreflight: false,
        });
        const result = await sponsorAction({
          action: 'confirm',
          token: receipt.token,
          attemptId: quote.attempt.id,
          signature,
        });
        if (result.receipt) onReceipt(result.receipt);
      }
      if (mounted.current) setPhase('checking');
    } catch (e) {
      if (!mounted.current) return;
      if (mayHaveBroadcast) {
        setPhase('checking');
        setError(
          'Your wallet may have sent this payment. We’ll check this attempt before offering another.',
        );
        try {
          const result = await sponsorAction({
            action: 'confirm',
            token: receipt.token,
            attemptId: quote.attempt.id,
          });
          if (result.receipt) onReceipt(result.receipt);
        } catch {
          /* The receipt poll resumes this exact order. */
        }
      } else {
        setPhase('ready');
        setError(
          e instanceof Error ? e.message : 'Wallet approval was cancelled.',
        );
      }
    } finally {
      pending.current = false;
      onPending(false);
    }
  }
  const expired = quote && now >= quote.attempt.expiresAt;
  return (
    <div className="sponsor-wallet">
      <div className="sponsor-wallet-connect">
        <WalletMultiButton />
      </div>
      {walletKey && phase === 'idle' && (
        <button type="button" className="sponsor-button" onClick={review}>
          Review wallet payment →
        </button>
      )}
      {phase === 'quoting' && (
        <p className="sponsor-working">Checking balance and network fees…</p>
      )}
      {quote && phase !== 'checking' && (
        <div className="sponsor-wallet-quote">
          <div>
            <span>You’ll approve</span>
            <strong>
              {quote.attempt.amountUi} {quote.attempt.asset}
            </strong>
          </div>
          <p>Paid directly to the studio. Your wallet shows the network fee.</p>
          <button
            type="button"
            className="sponsor-button"
            disabled={phase === 'signing' || !!expired}
            onClick={pay}
          >
            {phase === 'signing'
              ? 'Approve in your wallet…'
              : expired
                ? 'Quote window ended'
                : 'Approve and pay →'}
          </button>
          {expired && (
            <>
              <p>This timer does not mean a previous payment failed.</p>
              <button
                type="button"
                className="sponsor-text-button"
                onClick={check}
              >
                Check this payment
              </button>
              <button
                type="button"
                className="sponsor-text-button"
                onClick={review}
              >
                Refresh quote
              </button>
            </>
          )}
        </div>
      )}
      {phase === 'checking' && (
        <div>
          <p className="sponsor-working">Checking your payment on Solana…</p>
          <button type="button" className="sponsor-text-button" onClick={check}>
            Check again
          </button>
        </div>
      )}
      <output className="sponsor-error">{error}</output>
    </div>
  );
}
