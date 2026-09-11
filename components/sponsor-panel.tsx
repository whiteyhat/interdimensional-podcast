'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  ArrowRight,
  Check,
  ChevronDown,
  MessageCircle,
  ScanLine,
  Shirt,
  Sparkles,
  Upload,
  Wallet,
} from 'lucide-react';
import {
  sponsorProducts,
  validateSponsorDraft,
  type SponsorAsset,
  type SponsorCatalog,
  type SponsorDraft,
  type SponsorReceipt as Receipt,
} from '@/lib/sponsorship';
import {
  catalogPriceCents,
  checkoutKey,
  dollars,
  emptyDraft,
  productCopy,
  readCheckout,
} from '@/lib/sponsor-client';
import {
  loadSponsorCatalog,
  loadSponsorReceipt,
  sponsorAction,
} from '@/lib/sponsor-browser';
import { SponsorPreview } from './sponsor-preview';
import { SponsorStepper } from './sponsor-stepper';
import { SponsorReceipt } from './sponsor-receipt';
import { celebratePayment } from '@/lib/celebrate';
const SponsorWallet = dynamic(
  () => import('./sponsor-wallet').then((m) => m.SponsorWallet),
  {
    ssr: false,
    loading: () => (
      <p className="sponsor-working">Opening the wallet connection…</p>
    ),
  },
);
const SponsorQR = dynamic(
  () => import('./sponsor-qr').then((m) => m.SponsorQR),
  {
    ssr: false,
    loading: () => <p className="sponsor-working">Preparing your QR…</p>,
  },
);
const ICONS = { message: MessageCircle, spotlight: Sparkles, cap: Shirt };
const BADGES: Partial<Record<SponsorDraft['product'], string>> = {
  spotlight: 'Top seller',
  cap: 'Most value',
};
const ASSETS: SponsorAsset[] = ['USDC', 'SOL', 'FROGCLENCH'];
const STEPS = ['Choose', 'Write', 'Pay'];

/** The public contribution surface owns the draft; wallet providers arrive only at review. */
export function SponsorPanel() {
  const [draft, setDraft] = useState<SponsorDraft>({ ...emptyDraft });
  const [asset, setAsset] = useState<SponsorAsset>('USDC');
  const [catalog, setCatalog] = useState<SponsorCatalog | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [method, setMethod] = useState<'wallet' | 'qr'>('wallet');
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [artwork, setArtwork] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const form = useRef<HTMLFormElement>(null);
  const stepPanel = useRef<HTMLDivElement>(null);
  const navigated = useRef(false);
  const file = useRef<HTMLInputElement>(null);
  const receiptRef = useRef<Receipt | null>(null);
  const operation = useRef(false);
  const assetEpoch = useRef(0);
  const touchedToken = useRef<string | null>(null);
  const chosenAsset = useRef(false);
  const updateReceipt = useCallback((next: Receipt) => {
    receiptRef.current = next;
    setReceipt(next);
    setToken(next.token);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('receipt', next.token);
      history.replaceState(null, '', url);
      const keys = JSON.parse(
        localStorage.getItem('pepe-chad:receipts:v1') || '[]',
      ) as string[];
      localStorage.setItem(
        'pepe-chad:receipts:v1',
        JSON.stringify(
          [
            next.token,
            ...keys.filter((k) => typeof k === 'string' && k !== next.token),
          ].slice(0, 20),
        ),
      );
    } catch {
      /* The live receipt and its explicit link also work without storage. */
    }
  }, []);
  useEffect(() => {
    // Only a step the customer asked for moves focus; a restored receipt must not.
    if (!navigated.current) return;
    navigated.current = false;
    const node = stepPanel.current;
    if (!node) return;
    const field =
      step === 2
        ? node.querySelector<HTMLElement>('input:not([type="file"]), textarea')
        : null;
    (field || node).focus({ preventScroll: true });
  }, [step]);
  useEffect(() => {
    const timer = setTimeout(() => {
      let saved = readCheckout(null);
      try {
        saved = readCheckout(localStorage.getItem(checkoutKey));
      } catch {
        /* Private browsing. */
      }
      const explicit = new URLSearchParams(window.location.search).get(
        'receipt',
      );
      setDraft(saved.draft);
      setAsset(saved.asset);
      setArtwork(
        saved.draft.assetId
          ? `/api/sponsorship/assets/${encodeURIComponent(saved.draft.assetId)}`
          : null,
      );
      setToken(
        explicit && /^[a-zA-Z0-9_-]{32,180}$/.test(explicit)
          ? explicit
          : saved.token,
      );
      setLoaded(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(
        checkoutKey,
        JSON.stringify({ version: 1, draft, asset, token }),
      );
    } catch {
      /* Checkout can still proceed. */
    }
  }, [loaded, draft, asset, token]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await loadSponsorCatalog(controller.signal);
        if (!controller.signal.aborted) {
          setCatalog(data);
          // Opening on an asset this deployment cannot take would dead-end checkout on a
          // choice nobody made. Until the customer picks one, follow what is payable.
          setAsset((current) => {
            if (chosenAsset.current) return current;
            if (data.assets.find((a) => a.id === current)?.available)
              return current;
            return data.assets.find((a) => a.available)?.id ?? current;
          });
          setConnectionError('');
        }
      } catch {
        if (!controller.signal.aborted)
          setConnectionError(
            'Live availability is temporarily unavailable. Your draft is saved.',
          );
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 20000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await loadSponsorReceipt(token!, controller.signal);
        if (controller.signal.aborted) return;
        updateReceipt(next);
        if (touchedToken.current !== token) {
          setDraft(next.draft);
          setArtwork(next.assetUrl);
          setStep(3);
          const attempt =
            next.attempts.find((a) => a.status === 'verified') ||
            next.attempts[0];
          // A payment already quoted in this asset owns the choice from here on.
          if (attempt) {
            chosenAsset.current = true;
            setAsset(attempt.asset);
          }
          touchedToken.current = token;
        }
        if (next.status === 'payment-pending') {
          // Recovery is reference-based: mobile wallets need not report a signature to this page.
          const result = await sponsorAction(
            { action: 'confirm', token },
            controller.signal,
          );
          if (result.receipt && !controller.signal.aborted)
            updateReceipt(result.receipt);
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error
              ? e.message
              : 'Your receipt will reconnect shortly.',
          );
      }
      if (!controller.signal.aborted)
        timer = setTimeout(
          poll,
          receiptRef.current?.status === 'fulfilled' ? 30000 : 4000,
        );
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [token, updateReceipt]);
  const received =
    !!receipt && !['draft', 'payment-pending'].includes(receipt.status);
  // Celebrate the payment the viewer watched confirm, once, and only that: a receipt that
  // was already paid when the page opened is a return visit, not a moment.
  const seenStatus = useRef<{ id: string; status: string } | null>(null);
  useEffect(() => {
    if (!receipt) return;
    const before = seenStatus.current;
    seenStatus.current = { id: receipt.id, status: receipt.status };
    if (
      received &&
      before?.id === receipt.id &&
      ['draft', 'payment-pending'].includes(before.status)
    )
      void celebratePayment(document.querySelector('.sponsor-receipt'));
  }, [receipt, received]);
  const locked = step === 3 || received || signing;
  const price = catalogPriceCents(catalog, draft.product, asset);
  const fullPrice = catalogPriceCents(catalog, draft.product, 'USDC');
  const product = catalog?.products.find((p) => p.id === draft.product);
  const assetState = catalog?.assets.find((a) => a.id === asset);
  const hostReserved =
    draft.product === 'cap' &&
    catalog?.capInventory?.[draft.target || 'host'] === false;
  const unavailableReason = hostReserved
    ? 'This host’s cap is reserved. Choose the other host, or keep your draft for later.'
    : product?.reason || assetState?.reason;
  const available =
    !!product?.available && !!assetState?.available && !hostReserved;
  function change(patch: Partial<SponsorDraft>) {
    if (locked) return;
    if (patch.product || patch.target) {
      assetEpoch.current++;
      setArtwork(null);
      patch.assetId = undefined;
    }
    setDraft((d) => ({ ...d, ...patch }));
    setFieldErrors({});
    setError('');
  }
  async function upload(selected: File | undefined) {
    if (!selected || uploading || locked) return;
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(selected.type) ||
      selected.size > 4 * 1024 * 1024
    ) {
      setFieldErrors({ assetId: 'Use a PNG, JPG, or WebP image under 4 MB.' });
      return;
    }
    setUploading(true);
    setError('');
    const epoch = ++assetEpoch.current;
    try {
      const data = new FormData();
      data.set('image', selected);
      data.set('kind', draft.product === 'cap' ? 'cap' : 'logo');
      data.set('target', draft.target || 'host');
      const response = await fetch('/api/sponsorship/assets', {
        method: 'POST',
        body: data,
        signal: AbortSignal.timeout(45000),
      });
      const result = (await response.json()) as {
        id?: string;
        url?: string;
        error?: string;
      };
      if (!response.ok || !result.id || !result.url)
        throw Error(result.error || 'Your artwork could not be prepared.');
      if (epoch !== assetEpoch.current) return;
      setDraft((d) => ({ ...d, assetId: result.id }));
      setArtwork(result.url);
      setFieldErrors({});
    } catch (e) {
      if (epoch === assetEpoch.current)
        setFieldErrors({
          assetId:
            e instanceof Error
              ? e.message
              : 'Your artwork could not be prepared.',
        });
    } finally {
      setUploading(false);
      if (file.current) file.current.value = '';
    }
  }
  async function review(e: React.SubmitEvent) {
    e.preventDefault();
    if (operation.current) return;
    const fields: Record<string, string> = {};
    if (draft.product !== 'message' && !draft.projectName?.trim())
      fields.projectName = 'Give your project a name.';
    if (draft.message.trim().length < 3)
      fields.message = 'Give the hosts a little more to work with.';
    if (draft.product === 'cap' && !draft.assetId)
      fields.assetId = 'Add your logo to preview the cap.';
    if (Object.keys(fields).length) {
      setFieldErrors(fields);
      document.getElementById(`sponsor-${Object.keys(fields)[0]}`)?.focus();
      return;
    }
    try {
      validateSponsorDraft(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check your details.');
      return;
    }
    if (!available) {
      setError(
        unavailableReason ||
          'Payments reopen when the studio is ready. You can keep customizing.',
      );
      return;
    }
    operation.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await sponsorAction({ action: 'draft', draft });
      if (!result.receipt) throw Error('The studio could not save this order.');
      updateReceipt(result.receipt);
      touchedToken.current = result.receipt.token;
      goStep(3);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Your order could not be saved.',
      );
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  async function useQR() {
    if (!receipt || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    setMethod('qr');
    try {
      const result = await sponsorAction({
        action: 'quote',
        token: receipt.token,
        asset,
      });
      if (result.receipt) updateReceipt(result.receipt);
      const url = result.solanaPayUrl || result.attempt?.solanaPayUrl;
      if (!url) throw Error('A wallet link could not be prepared.');
      setQr(url);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'The QR could not be prepared.',
      );
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  async function act(action: 'reschedule') {
    if (!receipt || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await sponsorAction({ action, token: receipt.token });
      if (result.receipt) updateReceipt(result.receipt);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'The studio could not complete that step.',
      );
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  function goStep(next: 1 | 2 | 3) {
    navigated.current = true;
    setStep(next);
  }
  function pickAsset(next: SponsorAsset) {
    if (next === asset || signing) return;
    chosenAsset.current = true;
    setAsset(next);
    setMethod('wallet');
    setQr('');
    setError('');
  }
  function newOrder(back: 1 | 2 = 1) {
    if (signing) return;
    setReceipt(null);
    receiptRef.current = null;
    setToken(null);
    setQr('');
    navigated.current = true;
    setStep(back);
    setMethod('wallet');
    setError('');
    touchedToken.current = null;
    const url = new URL(location.href);
    url.searchParams.delete('receipt');
    history.replaceState(null, '', url);
  }
  const errorFor = (field: string) =>
    fieldErrors[field] ? (
      <span className="sponsor-field-error" id={`sponsor-${field}-error`}>
        {fieldErrors[field]}
      </span>
    ) : null;
  return (
    <section className="sponsor-panel" aria-labelledby="sponsor-title">
      <div className="sponsor-panel-top">
        <span className="sponsor-kicker">THE MIC IS OPEN TO YOU</span>
        <span
          className={`sponsor-signal ${catalog?.studioOnline ? 'online' : ''}`}
        >
          <i />
          {catalog?.studioOnline ? 'LIVE' : 'OFF AIR'}
        </span>
      </div>
      <h2 id="sponsor-title">Be part of the show.</h2>
      <p className="sponsor-lead">
        A thought. A project. A cap with your name on it.
      </p>
      {received && receipt ? (
        <SponsorReceipt
          receipt={receipt}
          busy={busy}
          onAction={act}
          onNew={() => newOrder(1)}
        />
      ) : (
        <form ref={form} className="sponsor-form" onSubmit={review} noValidate>
          <SponsorStepper steps={STEPS} current={step} />
          <div
            key={step}
            ref={stepPanel}
            className="sponsor-step-panel"
            tabIndex={-1}
          >
            {step === 1 ? (
              <>
                <fieldset className="sponsor-products" disabled={locked}>
                  <legend className="sr-only">Choose your sponsorship</legend>
                  {sponsorProducts.map((p, i) => {
                    const Icon = ICONS[p.id];
                    const selected = draft.product === p.id;
                    return (
                      <label
                        key={p.id}
                        className={`sponsor-product ${selected ? 'selected' : ''}`}
                      >
                        <input
                          type="radio"
                          name="sponsor-product"
                          value={p.id}
                          checked={selected}
                          onChange={() => change({ product: p.id })}
                        />
                        <span className="sponsor-product-icon">
                          <Icon size={18} />
                        </span>
                        <span className="sponsor-product-copy">
                          <span className="sponsor-product-title">
                            <b>{productCopy[p.id].title}</b>
                            {BADGES[p.id] && (
                              <span className="sponsor-product-badge">
                                {BADGES[p.id]}
                              </span>
                            )}
                          </span>
                          <small>
                            {i === 0
                              ? 'A message, answered on air'
                              : i === 1
                                ? 'Four turns. Your project.'
                                : 'Your logo on Pepe or Chad'}
                          </small>
                        </span>
                        <span className="sponsor-product-price">
                          {dollars(catalogPriceCents(catalog, p.id, asset))}
                          <small>
                            {asset === 'FROGCLENCH' ? 'with FROG' : 'USD'}
                          </small>
                        </span>
                        <span className="sponsor-radio" aria-hidden="true">
                          {selected && <Check size={10} />}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
                <button
                  type="button"
                  className="sponsor-button"
                  disabled={!loaded}
                  onClick={() => goStep(2)}
                >
                  Continue <ArrowRight size={17} />
                </button>
                <p className="sponsor-checkout-note">
                  {!available
                    ? connectionError ||
                      unavailableReason ||
                      'Explore and customize while the studio is off air.'
                    : 'One short step, then payment. No account needed.'}
                </p>
              </>
            ) : step === 2 ? (
              <>
                {draft.product === 'cap' && (
                  <fieldset className="sponsor-host-choice">
                    <legend>Who’s wearing it?</legend>
                    {(['host', 'guest'] as const).map((target) => (
                      <label
                        key={target}
                        className={draft.target === target ? 'selected' : ''}
                      >
                        <input
                          type="radio"
                          name="sponsor-host"
                          value={target}
                          checked={draft.target === target}
                          onChange={() => change({ target })}
                        />
                        {target === 'host' ? 'Pepe' : 'GigaChad'}
                        <span>
                          {catalog?.capInventory?.[target] === false
                            ? 'Reserved'
                            : target === 'host'
                              ? 'Still holding.'
                              : 'Never sold.'}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                )}
                {draft.product !== 'message' && (
                  <label
                    className="sponsor-field"
                    htmlFor="sponsor-projectName"
                  >
                    <span>Project or token name</span>
                    <input
                      id="sponsor-projectName"
                      name="projectName"
                      value={draft.projectName || ''}
                      maxLength={20}
                      placeholder="Your project, in plain words"
                      onChange={(e) => change({ projectName: e.target.value })}
                      aria-invalid={!!fieldErrors.projectName}
                      aria-describedby={
                        fieldErrors.projectName
                          ? 'sponsor-projectName-error'
                          : undefined
                      }
                    />
                    {errorFor('projectName')}
                  </label>
                )}
                {draft.product === 'cap' && (
                  <div className="sponsor-upload">
                    <input
                      className="sr-only"
                      ref={file}
                      id="sponsor-logo-file"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => void upload(e.target.files?.[0])}
                    />
                    <button
                      id="sponsor-assetId"
                      className="sponsor-upload-button"
                      type="button"
                      onClick={() => file.current?.click()}
                      disabled={uploading}
                      aria-describedby={
                        fieldErrors.assetId
                          ? 'sponsor-assetId-error sponsor-upload-help'
                          : 'sponsor-upload-help'
                      }
                    >
                      <Upload size={16} />
                      <span>
                        {uploading
                          ? 'Preparing your artwork…'
                          : draft.assetId
                            ? 'Change your logo'
                            : 'Add your logo'}
                        <small>Preview it on the actual cap</small>
                      </span>
                      {draft.assetId && <Check size={16} />}
                    </button>
                    <p id="sponsor-upload-help">
                      PNG, JPG, or WebP · up to 4 MB
                    </p>
                    {errorFor('assetId')}
                  </div>
                )}
                <label className="sponsor-field" htmlFor="sponsor-message">
                  <span>
                    {draft.product === 'message'
                      ? 'Give them something to talk about'
                      : 'What should they know?'}
                    <small>{draft.message.length}/240</small>
                  </span>
                  <textarea
                    id="sponsor-message"
                    name="message"
                    value={draft.message}
                    maxLength={240}
                    rows={4}
                    placeholder={
                      draft.product === 'message'
                        ? 'A question, a hot take, a story from the trenches…'
                        : 'Tell us what you’re building. Keep claims specific and accurate.'
                    }
                    onChange={(e) => change({ message: e.target.value })}
                    aria-invalid={!!fieldErrors.message}
                    aria-describedby={
                      fieldErrors.message
                        ? 'sponsor-message-error'
                        : 'sponsor-message-hint'
                    }
                  />
                  {errorFor('message')}
                  <small id="sponsor-message-hint">
                    One or two lines is plenty. Links and wallet addresses stay
                    out of the spoken brief.
                  </small>
                </label>
                <button
                  type="submit"
                  className="sponsor-button"
                  disabled={busy || uploading || !loaded}
                >
                  {busy ? (
                    'Saving your pass…'
                  ) : (
                    <>
                      Continue to payment <ArrowRight size={17} />
                    </>
                  )}
                </button>
                <p className="sponsor-checkout-note">
                  {!available
                    ? connectionError ||
                      unavailableReason ||
                      'Explore and customize while the studio is off air.'
                    : 'Connect a wallet at the next step. Network fees are separate.'}
                </p>
                <button
                  type="button"
                  className="sponsor-text-button"
                  onClick={() => goStep(1)}
                >
                  ← Back
                </button>
              </>
            ) : receipt ? (
              <>
                <div className="sponsor-review-summary">
                  <b>{productCopy[draft.product].title}</b>
                  <p>{draft.message}</p>
                  <div>
                    <span>
                      {asset === 'FROGCLENCH'
                        ? '30% FROGCLENCH discount'
                        : 'Paying with ' + asset}
                    </span>
                    <strong>
                      {asset === 'FROGCLENCH' && (
                        <del>{dollars(fullPrice)}</del>
                      )}
                      {dollars(price)}
                    </strong>
                  </div>
                </div>
                <fieldset className="sponsor-assets" disabled={signing || busy}>
                  <legend>
                    Choose how to pay <span>Solana</span>
                  </legend>
                  <div>
                    {ASSETS.map((a) => (
                      <label key={a} className={asset === a ? 'selected' : ''}>
                        <input
                          type="radio"
                          name="sponsor-asset"
                          value={a}
                          checked={asset === a}
                          onChange={() => pickAsset(a)}
                        />
                        <span>{a === 'FROGCLENCH' ? '$FROG' : a}</span>
                        {a === 'FROGCLENCH' && <small>−30%</small>}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset
                  className="sponsor-payment-methods"
                  aria-label="Payment method"
                >
                  <button
                    type="button"
                    className={method === 'wallet' ? 'selected' : ''}
                    disabled={signing}
                    onClick={() => setMethod('wallet')}
                  >
                    <Wallet size={15} />
                    This wallet
                  </button>
                  <button
                    type="button"
                    className={method === 'qr' ? 'selected' : ''}
                    disabled={signing || busy}
                    onClick={useQR}
                  >
                    <ScanLine size={15} />
                    Scan to pay
                  </button>
                </fieldset>
                {method === 'wallet' ? (
                  <SponsorWallet
                    key={`${receipt.token}:${asset}`}
                    receipt={receipt}
                    asset={asset}
                    endpoint={catalog?.clientRpcUrl || '/api/rpc'}
                    onReceipt={updateReceipt}
                    onPending={setSigning}
                  />
                ) : qr ? (
                  <SponsorQR url={qr} />
                ) : (
                  <p className="sponsor-working">Preparing your wallet link…</p>
                )}
                <p className="sponsor-checkout-note">
                  Your payment goes directly to the studio. This pass is saved
                  if you leave the page.
                </p>
                {receipt.attempts.length === 0 && (
                  <button
                    type="button"
                    className="sponsor-text-button"
                    onClick={() => newOrder(2)}
                  >
                    ← Edit this pass
                  </button>
                )}
              </>
            ) : (
              <p className="sponsor-working">Loading your saved pass…</p>
            )}
          </div>
        </form>
      )}
      <SponsorPreview
        draft={draft}
        artwork={artwork || receipt?.assetUrl}
        paid={received}
      />
      <p className="sponsor-error" role="alert">
        {error}
      </p>
      <details className="sponsor-explainer">
        <summary>
          How your moment reaches the show <ChevronDown size={14} />
        </summary>
        <p>{productCopy[draft.product].description}</p>
        <p>
          Payment confirms your place. Already-prepared footage plays first.
          Your receipt updates when the placement actually airs.
        </p>
        <p>
          If the stream pauses, we keep your unfinished placement and it resumes
          in the next live slot. Every placement is final once paid.
        </p>
      </details>
    </section>
  );
}
