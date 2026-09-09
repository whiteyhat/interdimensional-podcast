'use client';
import { useEffect, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { VersionedTransaction } from '@solana/web3.js';
import { ArrowUpRight } from 'lucide-react';
import { WalletShell } from '@/components/wallet';
import { publicRpc, type PublicConfig } from '@/hooks/use-config';
import { type PublicRequest } from '@/hooks/use-requests';
import { formatTokens } from '@/lib/format';
import { checkMessage, checkName, requestConfig, spokenName } from '@/lib/requests';
import { defaultBrand } from '@/lib/show';

type Quote = {
  reference: string;
  /** Base64 wire transaction from the studio; the client never builds one. */
  tx: string;
  amountUi: number;
  expiresAt: number;
  issuedAt: number;
  /** Name the hosts will say, resolved before payment so the receipt can show it. */
  from: string;
};
type Retry =
  | { kind: 'quote' }
  // Confirming only ever needs the payment's identity, never the quote that produced it.
  | { kind: 'confirm'; reference: string; from: string; signature: string | null };
type Flow =
  | { step: 'compose' }
  | { step: 'checking'; wallet: string }
  | { step: 'nocoin'; wallet: string; balance: number; needed: number; buyUrl: string | null }
  | { step: 'signing'; wallet: string; quote: Quote }
  | {
      step: 'confirming';
      wallet: string;
      reference: string;
      from: string;
      signature: string | null;
    }
  | { step: 'paid'; wallet: string; reference: string; from: string; position?: number }
  | { step: 'error'; wallet: string; message: string; retry: Retry | null };
const COMPOSE: Flow = { step: 'compose' };
type Props = {
  config: PublicConfig | null;
  /** The viewer's own request, followed by the parent's polling. */
  request: PublicRequest | null;
  /** Fires with the reference the card is following, or null once the viewer starts over. */
  onReference?: (reference: string | null) => void;
};

// A reload in the middle of a payment must not lose the receipt: the money may already be on chain.
const RECEIPT_KEY = 'interact:receipt';
const RESUME_WINDOW_MS = 10 * 60_000;
type Receipt = {
  reference: string;
  from: string;
  wallet: string;
  signature: string | null;
  paid: boolean;
  at: number;
};
function readReceipt(): Receipt | null {
  try {
    const raw = sessionStorage.getItem(RECEIPT_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<Receipt>;
    if (typeof r.reference !== 'string' || typeof r.at !== 'number') return null;
    if (Date.now() - r.at > 3_600_000) return null;
    return {
      reference: r.reference,
      from: typeof r.from === 'string' ? r.from : requestConfig.anonymous,
      wallet: typeof r.wallet === 'string' ? r.wallet : '',
      signature: typeof r.signature === 'string' ? r.signature : null,
      paid: r.paid === true,
      at: r.at,
    };
  } catch {
    return null;
  }
}
function writeReceipt(receipt: Receipt | null) {
  try {
    if (receipt) sessionStorage.setItem(RECEIPT_KEY, JSON.stringify(receipt));
    else sessionStorage.removeItem(RECEIPT_KEY);
  } catch {
    // Private mode or storage disabled: the flow still works, it just will not survive a reload.
  }
}
/**
 * The receipt is read once, here: the step the card opens on and the confirmation the card
 * must resume are the same decision, so they can never disagree and leave the viewer
 * watching a "waiting" screen with no loop behind it.
 */
function initialState(): { flow: Flow; resume: Receipt | null } {
  const r = readReceipt();
  if (!r) return { flow: COMPOSE, resume: null };
  if (r.paid)
    return {
      flow: { step: 'paid', wallet: r.wallet, reference: r.reference, from: r.from },
      resume: null,
    };
  // A receipt without a signature means the wallet was open when the page went away: the
  // payment may still have landed, so ask the studio to look before giving up on it.
  if (r.signature || Date.now() - r.at < RESUME_WINDOW_MS)
    return {
      flow: {
        step: 'confirming',
        wallet: r.wallet,
        reference: r.reference,
        from: r.from,
        signature: r.signature,
      },
      resume: r,
    };
  return { flow: COMPOSE, resume: null };
}

type Reply = { ok: boolean; status: number; json: Record<string, unknown> };
async function post(body: Record<string, unknown>): Promise<Reply> {
  const response = await fetch('/api/interact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  const json = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return { ok: response.ok, status: response.status, json };
}
function reason({ status, json }: Reply) {
  const code = typeof json.code === 'string' ? json.code : '';
  if (code === 'NOT_LAUNCHED') return 'The coin has not launched yet.';
  if (code === 'OFFAIR') return 'The studio just went off air. Try again when the stream is live.';
  if (code === 'TREASURY') return 'The studio wallet is not ready to receive yet. Try again in a few minutes.';
  if (status === 429) return 'Too many tries from this wallet. Give it a minute.';
  if (typeof json.error === 'string' && json.error) return json.error;
  return status >= 500 ? 'The studio server is having a moment. Try again.' : 'That did not go through.';
}
function readQuote(json: Record<string, unknown>, from: string): Quote | null {
  const reference = typeof json.reference === 'string' ? json.reference.trim() : '';
  const tx = typeof json.tx === 'string' ? json.tx : '';
  // The deadline is anchored to this device's clock: the server says how long, never when.
  const ttl = Number(json.ttlMs);
  const expiresAt =
    Date.now() + Math.min(Math.max(Number.isFinite(ttl) && ttl > 0 ? ttl : 60_000, 5_000), 60_000);
  if (!reference || !tx) return null;
  return {
    reference,
    tx,
    amountUi: Number(json.amountUi) || 0,
    expiresAt,
    issuedAt: Date.now(),
    from,
  };
}
const messageOf = (e: unknown) =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : '';
function describe(e: unknown) {
  const m = messageOf(e).trim();
  if (!m) return 'Something went wrong with the wallet.';
  return m.length > 160 ? `${m.slice(0, 157)}…` : m;
}
const rejected = (e: unknown) => /reject|denied|declin|cancel|closed by user|user closed/i.test(messageOf(e));
const cannotSend = (e: unknown) =>
  /not supported|unsupported|does not support|not implemented|sendTransaction is not/i.test(messageOf(e));
const staleBlockhash = (e: unknown) => /blockhash|block height|expired/i.test(messageOf(e));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// Every confirm costs the studio a row read and a handful of Solana calls, so the poll
// backs off: 1s, 1s, 2s, 4s, 8s, then every 10s. Same worst case, a tenth of the traffic.
const CONFIRM_DELAYS = [1000, 1000, 2000, 4000, 8000];
const confirmDelay = (attempt: number) =>
  attempt < CONFIRM_DELAYS.length ? CONFIRM_DELAYS[attempt] : 10_000;
function fromBase64(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function toBase64(bytes: Uint8Array) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function eta(position: number) {
  const s = position * 30;
  if (s < 60) return `${s}S`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}M ${rest}S` : `${m}M`;
}
/** A half-second clock, only while something on screen counts down. */
function useTick(active: boolean) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
function Working({ label }: { label: string }) {
  return (
    <p className="interact-working" aria-live="polite">
      <i />
      {label}
    </p>
  );
}

function InteractForm({ config, request, onReference }: Props) {
  const { connection } = useConnection();
  const { publicKey, connected, wallet, sendTransaction, signTransaction } = useWallet();
  const walletKey = publicKey?.toBase58() ?? '';
  const walletName = wallet?.adapter.name ?? 'your wallet';
  const [start] = useState(initialState);
  const [flow, setFlow] = useState<Flow>(start.flow);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  // Every flow gets a run number; an older run that finishes late is ignored.
  const epoch = useRef(0);

  // A flow belonging to another wallet is dropped. No wallet connected is not another
  // wallet, so a step survives the reconnect that follows a reload.
  const stale = !!walletKey && 'wallet' in flow && flow.wallet !== walletKey;
  const active: Flow = stale ? COMPOSE : flow;
  const reference =
    active.step === 'paid' || active.step === 'confirming' ? active.reference : undefined;
  useEffect(() => {
    onReference?.(reference ?? null);
  }, [reference, onReference]);
  useEffect(() => () => {
    epoch.current++;
  }, []);

  const ticker = config?.ticker ?? defaultBrand.ticker;
  const usd = config?.interactUsd ?? defaultBrand.usd;
  const price = `$${usd}`;
  // The server prices the seat; the card only shows the number it was given.
  const preview = config?.previewAmountUi ?? null;
  const message = checkMessage(text);
  const nick = checkName(name);
  const problem = touched ? (!message.ok ? message.error : !nick.ok ? nick.error : '') : '';
  const now = useTick(active.step === 'signing');

  // Everything from the balance check onward: a payment in motion outranks every gate.
  const inFlight = active.step !== 'compose' && active.step !== 'nocoin';

  const fail = (owner: string, msg: string, retry: Retry | null) => {
    setFlow({ step: 'error', wallet: owner, message: msg, retry });
  };

  const confirm = async (
    reference: string,
    from: string,
    owner: string,
    signature: string | null,
    run: number,
    budgetMs = 90_000,
  ) => {
    const deadline = Date.now() + budgetMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      if (run !== epoch.current) return;
      let res: Reply;
      try {
        res = await post({
          action: 'confirm',
          reference,
          ...(signature ? { signature } : {}),
        });
      } catch {
        await sleep(confirmDelay(attempt++));
        continue;
      }
      if (run !== epoch.current) return;
      const status = typeof res.json.status === 'string' ? res.json.status : '';
      if (status === 'paid' || status === 'claimed' || status === 'aired') {
        const position = Number(res.json.position);
        setFlow({
          step: 'paid',
          wallet: owner,
          reference,
          from,
          ...(Number.isInteger(position) && position > 0 ? { position } : {}),
        });
        writeReceipt({ reference, from, wallet: owner, signature, paid: true, at: Date.now() });
        return;
      }
      if (status === 'failed') {
        writeReceipt(null);
        fail(
          owner,
          typeof res.json.error === 'string' && res.json.error
            ? res.json.error
            : 'The transaction failed on chain, so no tokens moved.',
          { kind: 'quote' },
        );
        return;
      }
      if (status === 'expired') {
        writeReceipt(null);
        fail(owner, 'The quote expired before the payment landed. Get a fresh one.', { kind: 'quote' });
        return;
      }
      if (!res.ok && status !== 'pending') {
        // The money may already be on chain: a server hiccup is retried, only a 4xx is final.
        if (res.status >= 500) {
          await sleep(confirmDelay(attempt++));
          continue;
        }
        fail(owner, reason(res), { kind: 'confirm', reference, from, signature });
        return;
      }
      await sleep(confirmDelay(attempt++));
    }
    if (run !== epoch.current) return;
    fail(
      owner,
      'Solana has not confirmed the payment yet. It usually lands within a minute; check again.',
      { kind: 'confirm', reference, from, signature },
    );
  };

  // Resume a confirmation that a reload interrupted; the payment may already be on chain.
  useEffect(() => {
    const r = start.resume;
    if (!r) return;
    const run = ++epoch.current;
    const id = setTimeout(() => {
      void confirm(r.reference, r.from, r.wallet, r.signature, run, r.signature ? 90_000 : 45_000);
    }, 0);
    return () => clearTimeout(id);
    // `start` is this mount's one reading of the receipt, so this runs exactly once.
  }, [start]);

  /** Signs and sends one quote. 'requote' means the price lapsed and a fresh quote is needed. */
  const pay = async (quote: Quote, owner: string, run: number): Promise<'done' | 'requote'> => {
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(fromBase64(quote.tx));
    } catch {
      fail(owner, 'The studio sent a transaction this page could not read.', { kind: 'quote' });
      return 'done';
    }
    const versions = wallet?.adapter.supportedTransactionVersions;
    if (!versions?.has(0)) {
      fail(
        owner,
        `${walletName} cannot sign version 0 transactions, which this payment uses. Phantom, Solflare and Backpack can.`,
        null,
      );
      return 'done';
    }
    if (Date.now() >= quote.expiresAt) return 'requote';
    // The wallet may broadcast before this page hears back: remember the reference first.
    writeReceipt({ reference: quote.reference, from: quote.from, wallet: owner, signature: null, paid: false, at: Date.now() });
    let signature: string | null = null;
    try {
      signature = await sendTransaction(tx, connection, { maxRetries: 3 });
    } catch (e) {
      if (run !== epoch.current) return 'done';
      if (rejected(e)) {
        writeReceipt(null);
        fail(owner, 'The wallet closed without approving. Nothing was sent.', { kind: 'quote' });
        return 'done';
      }
      if (cannotSend(e) && signTransaction) {
        // The wallet can sign but not broadcast: the studio sends it for us.
        try {
          const signed = await signTransaction(tx);
          const res = await post({
            action: 'submit',
            reference: quote.reference,
            signedTx: toBase64(signed.serialize()),
          });
          if (run !== epoch.current) return 'done';
          if (res.status === 409 && res.json.code === 'REQUOTE') return 'requote';
          if (!res.ok || typeof res.json.signature !== 'string') {
            if (res.status >= 500) {
              // The studio may have broadcast before answering: look for the payment, never pay twice.
              setFlow({ step: 'confirming', wallet: owner, reference: quote.reference, from: quote.from, signature: null });
              await confirm(quote.reference, quote.from, owner, null, run, 45_000);
              return 'done';
            }
            fail(owner, reason(res), { kind: 'quote' });
            return 'done';
          }
          signature = res.json.signature;
        } catch (e2) {
          if (run !== epoch.current) return 'done';
          fail(
            owner,
            rejected(e2) ? 'The wallet closed without approving. Nothing was sent.' : describe(e2),
            { kind: 'quote' },
          );
          return 'done';
        }
      } else if (Date.now() >= quote.expiresAt || staleBlockhash(e)) {
        // The quote lapsed while the wallet was open: price it again, automatically.
        return 'requote';
      } else {
        // The wallet reported an error after it may have sent: look for the payment before quoting again.
        setFlow({ step: 'confirming', wallet: owner, reference: quote.reference, from: quote.from, signature: null });
        await confirm(quote.reference, quote.from, owner, null, run, 45_000);
        return 'done';
      }
    }
    writeReceipt({ reference: quote.reference, from: quote.from, wallet: owner, signature, paid: false, at: Date.now() });
    if (run !== epoch.current) {
      // A newer run took over, but this payment is real: tell the studio once anyway.
      void post({ action: 'confirm', reference: quote.reference, ...(signature ? { signature } : {}) }).catch(() => {});
      return 'done';
    }
    setFlow({ step: 'confirming', wallet: owner, reference: quote.reference, from: quote.from, signature });
    await confirm(quote.reference, quote.from, owner, signature, run);
    return 'done';
  };

  const startQuote = async () => {
    setTouched(true);
    const m = checkMessage(text);
    const n = checkName(name);
    if (!m.ok || !n.ok || !publicKey) return;
    const owner = publicKey.toBase58();
    const run = ++epoch.current;
    setFlow({ step: 'checking', wallet: owner });
    try {
      // A price holds for a minute. When the wallet takes longer, quote again, a few times at most.
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await post({
          action: 'quote',
          wallet: owner,
          message: m.text,
          ...(n.text ? { name: n.text } : {}),
        });
        if (run !== epoch.current) return;
        if (!res.ok) {
          fail(owner, reason(res), { kind: 'quote' });
          return;
        }
        if (res.json.hasEnough === false) {
          setFlow({
            step: 'nocoin',
            wallet: owner,
            balance: Number(res.json.balance) || 0,
            needed: Number(res.json.amountUi) || 0,
            buyUrl:
              typeof res.json.buyUrl === 'string' ? res.json.buyUrl : (config?.buyUrl ?? null),
          });
          return;
        }
        const quote = readQuote(res.json, spokenName(n.text));
        if (!quote) {
          fail(owner, 'The studio sent back a quote this page could not read.', { kind: 'quote' });
          return;
        }
        setFlow({ step: 'signing', wallet: owner, quote });
        if ((await pay(quote, owner, run)) === 'done') return;
        if (run !== epoch.current) return;
        setFlow({ step: 'checking', wallet: owner });
      }
      fail(owner, 'The price kept moving while the wallet was open. Try once more.', {
        kind: 'quote',
      });
    } catch (e) {
      if (run !== epoch.current) return;
      fail(owner, describe(e), { kind: 'quote' });
    }
  };

  const startOver = () => {
    epoch.current++;
    writeReceipt(null);
    setFlow(COMPOSE);
    setText('');
    setTouched(false);
  };
  const retry = (r: Retry | null) => {
    if (!r) {
      startOver();
      return;
    }
    if (r.kind === 'quote') {
      // After a reload the message is gone; send the viewer back to the form instead of a dead click.
      if (checkMessage(text).ok) void startQuote();
      else startOver();
      return;
    }
    const run = ++epoch.current;
    setFlow({ step: 'confirming', wallet: walletKey, reference: r.reference, from: r.from, signature: r.signature });
    void confirm(r.reference, r.from, walletKey, r.signature, run);
  };

  /** The card around every state; `state` keys the panel so each one animates in. */
  const card = (state: string, body: React.ReactNode) => (
    <section className="interact-card" aria-label={`Send a message for ${price}`}>
      <div className="interact-head">
        <span className="eyebrow">SEND A MESSAGE · {price}</span>
        {config && config.queued > 0 && state !== 'paid' && (
          <span className="eyebrow">{config.queued} IN LINE</span>
        )}
      </div>
      <div className="interact-state" key={state}>
        {body}
      </div>
    </section>
  );

  // The gates the show puts in front of the form; a payment already under way skips them all.
  if (!inFlight) {
    if (!config) return card('loading', <Working label="Checking in with the studio…" />);
    if (!config.launched)
      return card(
        'launching',
        <p className="interact-copy">
          You can send a message for {price} once {ticker} launches with the show.
        </p>,
      );
    if (!config.treasuryReady)
      return card(
        'treasury',
        <p className="interact-copy">
          {ticker} is live. You can send a message for {price} once the studio wallet is ready.
        </p>,
      );
    if (!config.studioOnline)
      return card(
        'offair',
        <p className="interact-copy">The studio is off air. Come back when the stream is live.</p>,
      );
    if (!connected || !publicKey)
      return card(
        'connect',
        <>
          <p className="interact-copy">
            <b>
              {price} of {ticker}
            </b>{' '}
            lets you send up to {requestConfig.limits.text} characters for the next exchange.
            Pepe and Chad will thank you by name and answer on air.
          </p>
          <WalletMultiButton />
          <p className="interact-note">Phantom, Solflare, Backpack or any Solana wallet. Nothing moves until you approve it.</p>
        </>,
      );
  }

  switch (active.step) {
    case 'compose':
      return card(
        'compose',
        <>
          <div className="interact-wallet-row">
            <WalletMultiButton />
          </div>
          <label className="interact-field">
            <span className="eyebrow">YOUR ON-AIR NAME (OPTIONAL)</span>
            <input
              value={name}
              maxLength={requestConfig.limits.name}
              placeholder="e.g. DegenDave"
              autoComplete="off"
              onChange={(e) => {
                setName(e.target.value);
                setTouched(true);
              }}
            />
          </label>
          <label className="interact-field">
            <span className="eyebrow">YOUR MESSAGE</span>
            <textarea
              value={text}
              maxLength={requestConfig.limits.text}
              rows={4}
              placeholder="Ask them anything. They answer on air."
              onChange={(e) => {
                setText(e.target.value);
                setTouched(true);
              }}
            />
          </label>
          <div className="interact-meta">
            <span className="interact-price">
              {preview
                ? `≈ ${formatTokens(preview)} ${ticker} FOR ${price}`
                : `CHECKING THE PRICE IN ${ticker}…`}
            </span>
            <span
              className={`interact-count${text.length >= requestConfig.limits.text ? ' full' : ''}`}
            >
              {text.length}/{requestConfig.limits.text}
            </span>
          </div>
          {problem && (
            <p className="interact-problem" key={problem} role="alert">
              {problem}
            </p>
          )}
          <button
            className="primary interact-send"
            disabled={!publicKey}
            onClick={() => void startQuote()}
          >
            Send for {price} worth of {ticker}
          </button>
        </>,
      );
    case 'checking':
      return card('checking', <Working label={`Checking your ${ticker} balance…`} />);
    case 'nocoin':
      return card(
        'nocoin',
        <>
          <p className="interact-copy">
            This wallet holds <b>{active.balance > 0 ? formatTokens(active.balance) : '0'} {ticker}</b>.
            Your message costs <b>{formatTokens(active.needed)} {ticker}</b>, about {price} right now.
          </p>
          <div className="interact-actions">
            {active.buyUrl && (
              <a className="primary" href={active.buyUrl} target="_blank" rel="noreferrer">
                Buy {ticker} on pump.fun <ArrowUpRight size={15} />
              </a>
            )}
            <button className="quiet" onClick={() => void startQuote()}>
              Check again
            </button>
          </div>
        </>,
      );
    case 'signing': {
      const clock = now || active.quote.issuedAt;
      const left = Math.max(0, Math.ceil((active.quote.expiresAt - clock) / 1000));
      const span = Math.max(1, active.quote.expiresAt - active.quote.issuedAt);
      const pct = Math.max(0, Math.min(100, ((active.quote.expiresAt - clock) / span) * 100));
      return card(
        'signing',
        <>
          <p className="interact-copy">
            Approve the transfer in {walletName}.{' '}
            <b>
              {formatTokens(active.quote.amountUi)} {ticker}
            </b>{' '}
            ({price}) goes to the studio wallet.
          </p>
          <p className={`interact-countdown${left === 0 ? ' expired' : ''}`}>
            <i style={{ width: `${pct}%` }} />
            <span>
              {left > 0
                ? `THIS PRICE HOLDS FOR ${left}S`
                : 'PRICE EXPIRED · APPROVE OR CLOSE THE WALLET AND WE REFRESH IT'}
            </span>
          </p>
        </>,
      );
    }
    case 'confirming':
      return card(
        'confirming',
        <>
          <Working label="Payment sent. Waiting for Solana to confirm…" />
          {active.signature && (
            <p className="interact-sig">TX {active.signature.slice(0, 8)}…{active.signature.slice(-8)}</p>
          )}
        </>,
      );
    case 'paid': {
      const status = request?.status ?? 'paid';
      const position = request?.position ?? active.position;
      if (status === 'aired')
        return card(
          'paid',
          <>
            <p className="interact-success">
              The hosts answered your message, <b>{active.from}</b>.
            </p>
            <div className="interact-actions">
              <button className="primary" onClick={startOver}>
                Send another
              </button>
            </div>
          </>,
        );
      if (status === 'failed' || status === 'expired')
        return card(
          'paid',
          <>
            <p className="notice interact-error" role="alert">
              The studio marked this request {status}. If tokens left your wallet, the studio has the
              signature and will sort it out.
            </p>
            <div className="interact-actions">
              <button className="primary" onClick={startOver}>
                Start over
              </button>
            </div>
          </>,
        );
      if (status === 'claimed')
        return card(
          'paid',
          <>
            <p className="interact-success">
              The hosts have it. Listen for <b>{active.from}</b>.
            </p>
            <p className="interact-note">
              You’ll hear their reply after the conversation already queued to play.
            </p>
          </>,
        );
      return card(
        'paid',
        <>
          <p className="interact-success">
            Paid. They will thank <b>{active.from}</b> on air.
          </p>
          <p className="interact-eta">
            {position ? (
              <>
                <b key={position}>#{position}</b> IN LINE · ROUGHLY {eta(position)}
              </>
            ) : (
              'IN LINE · NEXT EXCHANGE'
            )}
          </p>
        </>,
      );
    }
    case 'error': {
      const { retry: again } = active;
      return card(
        'error',
        <>
          <p className="notice interact-error" role="alert">
            {active.message}
          </p>
          <div className="interact-actions">
            {again && (
              <button className="primary" onClick={() => retry(again)}>
                {again.kind === 'confirm' ? 'Check again' : 'Try again'}
              </button>
            )}
            <button className="quiet" onClick={startOver}>
              Start over
            </button>
          </div>
        </>,
      );
    }
  }
}

/** The $5 seat: connect a wallet, write a line, pay in the show's coin, hear it on air. */
export function InteractCard(props: Props) {
  return (
    <WalletShell endpoint={props.config?.clientRpcUrl || publicRpc}>
      <InteractForm {...props} />
    </WalletShell>
  );
}
