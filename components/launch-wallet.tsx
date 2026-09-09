'use client';
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { WalletShell } from '@/components/wallet';
import { makeSignedEnvelope, reviewPrepared } from '@/lib/launch/artifact.mjs';

type Reviewed = Awaited<ReturnType<typeof reviewPrepared>>;
type Prepared = Reviewed & { raw: unknown; filename: string };
type Phase = 'idle' | 'reviewing' | 'signing';
const MAX_FILE_BYTES = 64 * 1024;

function sol(lamports: string): string {
  const value = BigInt(lamports);
  const unit = BigInt(1_000_000_000);
  const fraction = (value % unit).toString().padStart(9, '0').replace(/0+$/, '');
  return `${value / unit}${fraction ? `.${fraction}` : ''} SOL`;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'The transaction could not be reviewed or signed. Try again.';
}
function downloadSigned(artifact: Reviewed['artifact'], envelope: unknown) {
  const blob = new Blob([JSON.stringify(envelope, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `launch-${artifact.id.replace(/[^a-zA-Z0-9._-]/g, '_')}-${artifact.revision}.signed.json`;
    document.body.appendChild(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
  } finally {
    // Give the browser time to consume the download before releasing its object URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function LaunchSigner() {
  const { connection } = useConnection();
  const { publicKey, connected, wallet, signTransaction } = useWallet();
  const walletAddress = publicKey?.toBase58() ?? '';
  const adapter = wallet?.adapter;
  const generation = useRef(0);
  const busy = useRef(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Choose a prepared JSON file to begin.');
  const [acknowledged, setAcknowledged] = useState(false);
  const previousWallet = useRef({ walletAddress, adapter, signTransaction, connected });

  useLayoutEffect(() => {
    const previous = previousWallet.current;
    if (previous.walletAddress === walletAddress && previous.adapter === adapter && previous.signTransaction === signTransaction && previous.connected === connected) return;
    previousWallet.current = { walletAddress, adapter, signTransaction, connected };
    generation.current++;
    busy.current = false;
    setPhase('idle');
    setAcknowledged(false);
    setError('');
    setStatus('Wallet changed. Review the transaction details again before signing.');
  }, [walletAddress, adapter, signTransaction, connected]);
  useEffect(() => () => { generation.current++; busy.current = false; }, []);

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    const operation = ++generation.current;
    busy.current = false;
    setPrepared(null);
    setAcknowledged(false);
    setError('');
    setStatus('');
    setPhase('idle');
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError('Choose a prepared JSON file no larger than 64 KiB.');
      return;
    }
    setPhase('reviewing');
    setStatus('Checking the actual transaction, network and expiry…');
    try {
      const source = await file.text();
      if (operation !== generation.current) return;
      if (new TextEncoder().encode(source).byteLength > MAX_FILE_BYTES) throw new Error('Choose a prepared JSON file no larger than 64 KiB.');
      let raw: unknown;
      try { raw = JSON.parse(source); } catch { throw new Error('The file is not valid JSON. Choose the prepared launch artifact.'); }
      const result = await reviewPrepared(raw, connection);
      if (operation !== generation.current) return;
      setPrepared({ ...result, raw, filename: file.name });
      setStatus('Transaction reviewed. Check the addresses and maximum budget below.');
    } catch (error) {
      if (operation === generation.current) { setError(errorMessage(error)); setStatus(''); }
    } finally {
      if (operation === generation.current) setPhase('idle');
    }
  }

  const capable = !!signTransaction && !!adapter?.supportedTransactionVersions?.has(0);
  const matching = connected && !!prepared && walletAddress === prepared.artifact.creator;
  const canSign = matching && capable && acknowledged && phase === 'idle';
  async function sign() {
    if (!canSign || !prepared || !signTransaction || busy.current) return;
    const operation = ++generation.current;
    busy.current = true;
    setPhase('signing');
    setError('');
    setStatus('Rechecking the transaction, network and expiry before signing…');
    try {
      const reviewed = await reviewPrepared(prepared.raw, connection);
      if (operation !== generation.current) return;
      if (reviewed.artifact.creator !== walletAddress || reviewed.artifact.messageHash !== prepared.artifact.messageHash) throw new Error('The transaction changed. Import and review the prepared file again.');
      setStatus('Confirm the transaction in your wallet. This page only requests a signature.');
      const signed = await signTransaction(reviewed.transaction);
      if (operation !== generation.current) return;
      const envelope = makeSignedEnvelope(reviewed.artifact, signed);
      if (operation !== generation.current) return;
      downloadSigned(reviewed.artifact, envelope);
      setAcknowledged(false);
      setStatus('Signed file downloaded. Use the CLI submit command to broadcast this transaction.');
    } catch (error) {
      if (operation === generation.current) { setError(errorMessage(error)); setStatus('No signed file was downloaded.'); }
    } finally {
      if (operation === generation.current) { busy.current = false; setPhase('idle'); }
    }
  }

  const artifact = prepared?.artifact;
  return (
    <div className="launch-workbench">
      <section className="launch-panel" aria-labelledby="prepared-heading" aria-busy={phase === 'reviewing'}>
        <p className="launch-kicker">01 / PREPARED TRANSACTION</p>
        <h2 id="prepared-heading">Import and review</h2>
        <label htmlFor="launch-artifact">Prepared launch file</label>
        <input className="launch-file" id="launch-artifact" type="file" accept="application/json,.json" aria-describedby="launch-file-help launch-review-status" onChange={event => { void importFile(event); }} />
        <p className="launch-subvalue" id="launch-file-help">JSON · maximum 64 KiB. The file is reviewed in this browser.</p>
        {error ? <p className="launch-notice launch-error" role="alert">{error}</p> : null}
        <output className="launch-status launch-muted" id="launch-review-status" aria-live="polite">{status}</output>
        {artifact ? <>
          <dl className="launch-facts">
            <div><dt>Action</dt><dd>{artifact.kind === 'create' ? 'Create token + initial buy' : 'Create treasury token account'}</dd></div>
            <div><dt>Network</dt><dd>{artifact.network}</dd></div>
            <div><dt>Token</dt><dd>{artifact.name} · {artifact.symbol}</dd></div>
            <div><dt>Prepared revision</dt><dd>{artifact.id} / {artifact.revision}</dd></div>
            <div className="launch-fact-wide"><dt>Mint</dt><dd className="launch-address">{artifact.mint}</dd></div>
            <div className="launch-fact-wide"><dt>Creator / signing wallet</dt><dd className="launch-address">{artifact.creator}</dd></div>
            <div className="launch-fact-wide"><dt>Treasury</dt><dd className="launch-address">{artifact.treasury}</dd></div>
            <div className="launch-fact-wide"><dt>Metadata</dt><dd><a className="launch-address" href={artifact.metadataUri} target="_blank" rel="noreferrer">{artifact.metadataUri} ↗</a></dd></div>
          </dl>
          <div className="launch-spend" aria-label="Transaction spending review">
            <div><span>INITIAL BUY</span><strong>{sol(artifact.buyLamports)}</strong></div>
            <div><span>ESTIMATED DEBIT</span><strong>{sol(artifact.estimatedTotalLamports)}</strong></div>
            <div><span>MAXIMUM BUDGET</span><strong className="launch-cap">{sol(artifact.maxTotalLamports)}</strong></div>
          </div>
          <p className="launch-subvalue">Prepared file: {prepared.filename}. Valid through block height {artifact.lastValidBlockHeight}; expiry is checked again before the wallet opens.</p>
          <label className="launch-confirm"><input type="checkbox" checked={acknowledged} disabled={phase !== 'idle'} onChange={event => setAcknowledged(event.target.checked)} />I reviewed the addresses, network and maximum budget above.</label>
        </> : null}
      </section>
      <aside className="launch-panel launch-wallet-panel" aria-labelledby="signing-heading">
        <p className="launch-kicker">02 / CREATOR SIGNATURE</p>
        <h2 id="signing-heading">Sign the reviewed file</h2>
        <WalletMultiButton />
        {walletAddress ? <p className="launch-address">Connected: {walletAddress}</p> : <p className="launch-muted">Connect the creator wallet to sign.</p>}
        {connected && prepared && !matching ? <p className="launch-unknown">Connect the creator wallet shown in the transaction.</p> : null}
        {connected && !adapter?.supportedTransactionVersions?.has(0) ? <p className="launch-unknown">This wallet must support version 0 transactions.</p> : null}
        {connected && !signTransaction ? <p className="launch-unknown">This wallet does not support signing a transaction without sending it.</p> : null}
        <button className="launch-action" type="button" disabled={!canSign} onClick={() => { void sign(); }}>{phase === 'signing' ? 'Waiting for signature…' : 'Sign & download JSON'}</button>
        <p className="launch-muted">Signing creates a local file. The CLI submit command broadcasts the transaction.</p>
      </aside>
    </div>
  );
}

export function LaunchWallet() {
  const endpoint = new URL('/api/rpc', window.location.origin).href;
  return <WalletShell endpoint={endpoint}><LaunchSigner /></WalletShell>;
}
