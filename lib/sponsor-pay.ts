// Server-only direct transfers. SOL stays native; no swaps and no sponsored fee payer.
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  Keypair,
  type ParsedTransactionWithMeta,
} from '@solana/web3.js';
import { getBase58Decoder } from '@solana/kit';
import { SponsorError, freshJupiterPrice } from './sponsorship';
import type { AttemptRow } from './sponsor-db';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const TOKEN_PROGRAM = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);
export const TOKEN_2022_PROGRAM = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);
// Token-2022 extensions a mint may carry and still be paid directly: they describe the token,
// they do not touch what a transfer moves. Everything else -- a transfer fee, a transfer hook,
// a permanent delegate, a pause switch, a scaled UI amount, confidential transfers -- can make
// the treasury receive something other than the quoted amount, or stop the transfer landing at
// all, so a mint carrying one stays closed rather than being charged a different net.
const SAFE_MINT_EXTENSIONS = new Set([
  18, // MetadataPointer
  19, // TokenMetadata
  20, // GroupPointer
  21, // TokenGroup
  22, // GroupMemberPointer
  23, // TokenGroupMember
]);
// A mint or account carrying extensions is padded to the 165-byte account size, then one byte
// saying which it is, then type/length/value entries. A plain Token-2022 mint has none of this
// and is the classic 82 bytes, exactly like a Token program mint.
const TLV_START = 166;
const TYPE_MINT = 1;
const TYPE_ACCOUNT = 2;

/** The extension types declared after the base record, or null if the bytes do not parse. */
function extensionTypes(data: Buffer, kind: number): number[] | null {
  if (data.length < TLV_START || data[TLV_START - 1] !== kind) return null;
  const types: number[] = [];
  for (let at = TLV_START; at + 4 <= data.length; ) {
    const type = data.readUInt16LE(at);
    // Type 0 is the uninitialized tail of a record sized for extensions it does not have yet.
    if (type === 0) break;
    at += 4 + data.readUInt16LE(at + 2);
    if (at > data.length) return null;
    types.push(type);
  }
  return types;
}
const ATA_PROGRAM = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);
const connections = new Map<string, Connection>();
export function sponsorConnection(url: string) {
  let c = connections.get(url);
  if (!c) {
    c = new Connection(url, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
      confirmTransactionInitialTimeout: 15000,
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(12000) }),
    });
    connections.set(url, c);
  }
  return c;
}
export function validWallet(raw: unknown): raw is string {
  try {
    return (
      typeof raw === 'string' &&
      new PublicKey(raw).toBase58() === raw &&
      PublicKey.isOnCurve(new PublicKey(raw).toBytes())
    );
  } catch {
    return false;
  }
}
/**
 * The associated token account. The owning token program is one of the seeds, so the same
 * wallet and mint under Token-2022 address a different account than under the Token program:
 * passing the wrong one reads an empty balance and would pay into an account nobody owns.
 */
export function ata(
  owner: string,
  mint: string,
  program: PublicKey = TOKEN_PROGRAM,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBuffer(),
      program.toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    ATA_PROGRAM,
  )[0];
}
export function randomPayReference(): string {
  return Keypair.generate().publicKey.toBase58();
}
export async function fetchSponsorPrice(
  c: Connection,
  mint: string,
  key: string | undefined,
  now: number,
): Promise<string> {
  if (!key)
    throw new SponsorError(503, 'Price service is not configured.', 'PRICE');
  const r = await fetch(
    `https://api.jup.ag/price/v3?ids=${encodeURIComponent(mint)}`,
    {
      headers: { 'x-api-key': key },
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    },
  );
  if (!r.ok)
    throw new SponsorError(503, 'A fresh asset price is unavailable.', 'PRICE');
  const body = (await r.json()) as Record<string, { blockId?: number }>;
  const entry = body[mint];
  if (!entry || !Number.isSafeInteger(entry.blockId))
    throw new SponsorError(503, 'A fresh asset price is unavailable.', 'PRICE');
  return freshJupiterPrice(entry, await c.getBlockTime(entry.blockId!), now);
}
export async function tokenInfo(
  c: Connection,
  mint: string,
): Promise<{ decimals: number; program: PublicKey }> {
  const data = await c.getAccountInfo(new PublicKey(mint), 'confirmed');
  const classic = !!data && data.owner.equals(TOKEN_PROGRAM);
  const extended = !!data && data.owner.equals(TOKEN_2022_PROGRAM);
  if (
    !data ||
    (!classic && !extended) ||
    data.data.length < 82 ||
    data.data[45] !== 1
  )
    throw new SponsorError(
      503,
      'This mint is not supported for direct sponsorship payments.',
      'MINT',
    );
  // 82 bytes is a mint with no extensions under either program. Anything longer must be a
  // Token-2022 mint whose extensions all leave a transfer's amount and outcome alone.
  if (data.data.length !== 82) {
    const types = extended ? extensionTypes(data.data, TYPE_MINT) : null;
    if (!types || types.some((t) => !SAFE_MINT_EXTENSIONS.has(t)))
      throw new SponsorError(
        503,
        'This mint is not supported for direct sponsorship payments.',
        'MINT',
      );
  }
  const decimals = data.data[44];
  if (decimals > 12)
    throw new SponsorError(503, 'This mint has unsupported precision.', 'MINT');
  return { decimals, program: classic ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM };
}
export async function spendable(
  c: Connection,
  owner: string,
  mint: string | null,
  program: PublicKey = TOKEN_PROGRAM,
): Promise<{ sol: bigint; tokens: bigint; hasAta: boolean }> {
  const sol = BigInt(await c.getBalance(new PublicKey(owner), 'confirmed'));
  if (!mint) return { sol, tokens: sol, hasAta: true };
  const account = await c.getAccountInfo(ata(owner, mint, program), 'confirmed');
  if (!account) return { sol, tokens: BigInt(0), hasAta: false };
  // A token account's own extensions cannot change what a transfer moves -- the ones that
  // could only exist on a mint this code already refuses -- so the bytes only have to parse.
  const extended =
    account.data.length !== 165 &&
    extensionTypes(account.data, TYPE_ACCOUNT) !== null;
  if (
    !account.owner.equals(program) ||
    (account.data.length !== 165 && !extended) ||
    account.data[108] !== 1 ||
    !account.data.subarray(0, 32).equals(new PublicKey(mint).toBuffer()) ||
    !account.data.subarray(32, 64).equals(new PublicKey(owner).toBuffer())
  )
    throw new SponsorError(
      503,
      'The token account cannot make a direct payment.',
      'ACCOUNT',
    );
  return { sol, tokens: account.data.readBigUInt64LE(64), hasAta: true };
}
function tokenTransfer(
  from: string,
  to: string,
  mint: string,
  amount: bigint,
  decimals: number,
  reference: string,
  program: PublicKey,
) {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  // transferChecked is instruction 12 in both programs, and both take the same accounts.
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: ata(from, mint, program), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: ata(to, mint, program), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(from), isSigner: true, isWritable: false },
      { pubkey: new PublicKey(reference), isSigner: false, isWritable: false },
    ],
    data,
  });
}
export async function buildSponsorTransaction(
  c: Connection,
  v: {
    wallet: string;
    recipient: string;
    mint: string | null;
    amountBase: string;
    decimals: number;
    reference: string;
  },
): Promise<{
  transaction: string;
  lastValidBlockHeight: number;
  feeLamports: string;
}> {
  if (
    !validWallet(v.wallet) ||
    !validWallet(v.recipient) ||
    v.wallet === v.recipient
  )
    throw new SponsorError(
      400,
      'Choose a different valid payment wallet.',
      'WALLET',
    );
  // The quote stored a mint and its decimals; which program owns it is read fresh here rather
  // than carried in the row, and the decimals are checked against the chain, because they are
  // what the transfer is denominated in.
  const token = v.mint ? await tokenInfo(c, v.mint) : null;
  if (token && token.decimals !== v.decimals)
    throw new SponsorError(
      409,
      'This mint changed since the quote was issued. Ask for a new one.',
      'MINT',
    );
  const program = token?.program ?? TOKEN_PROGRAM;
  const [balance, destination, latest] = await Promise.all([
    spendable(c, v.wallet, v.mint, program),
    spendable(c, v.recipient, v.mint, program),
    c.getLatestBlockhash('confirmed'),
  ]);
  const amount = BigInt(v.amountBase);
  if (amount <= BigInt(0) || balance.tokens < amount)
    throw new SponsorError(
      409,
      `Not enough ${v.mint ? 'tokens' : 'SOL'} for this payment. SOL is also needed for network fees.`,
      'BALANCE',
    );
  const tx = new Transaction({
    feePayer: new PublicKey(v.wallet),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 60000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }),
  );
  if (v.mint) {
    if (!destination.hasAta)
      throw new SponsorError(
        503,
        'The treasury token account is not ready.',
        'TREASURY',
      );
    tx.add(
      tokenTransfer(
        v.wallet,
        v.recipient,
        v.mint,
        amount,
        v.decimals,
        v.reference,
        program,
      ),
    );
  } else {
    const ix = SystemProgram.transfer({
      fromPubkey: new PublicKey(v.wallet),
      toPubkey: new PublicKey(v.recipient),
      lamports: amount,
    });
    ix.keys.push({
      pubkey: new PublicKey(v.reference),
      isSigner: false,
      isWritable: false,
    });
    tx.add(ix);
  }
  // A partially signed Solana Pay request must retain its lifetime. This unfunded
  // memo signer binds the server quote; the viewer remains the sole fee payer.
  const lifetimeSigner = Keypair.generate();
  tx.add(
    new TransactionInstruction({
      programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
      keys: [
        { pubkey: lifetimeSigner.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(`Sponsorship ${v.reference}`),
    }),
  );
  const fee = (await c.getFeeForMessage(tx.compileMessage(), 'confirmed'))
    .value;
  if (fee === null)
    throw new SponsorError(503, 'Network fees are unavailable.', 'FEE');
  const required = BigInt(fee) + (v.mint ? BigInt(0) : amount);
  if (balance.sol < required)
    throw new SponsorError(
      409,
      'Add SOL for the network fee before paying.',
      'SOL_FEE',
    );
  tx.partialSign(lifetimeSigner);
  return {
    transaction: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    lastValidBlockHeight: latest.lastValidBlockHeight,
    feeLamports: BigInt(fee).toString(),
  };
}
export function inspectSponsorSigned(
  base64: string,
  unsigned: string,
): { signature: string; wire: Buffer } {
  try {
    const tx = Transaction.from(Buffer.from(base64, 'base64')),
      original = Transaction.from(Buffer.from(unsigned, 'base64'));
    if (
      !tx.serializeMessage().equals(original.serializeMessage()) ||
      !tx.verifySignatures() ||
      !tx.signature
    )
      throw Error();
    return {
      signature: getBase58Decoder().decode(tx.signature),
      wire: tx.serialize(),
    };
  } catch {
    throw new SponsorError(
      400,
      'The signed transaction does not match this payment attempt.',
      'TRANSACTION',
    );
  }
}
type EvidenceFields = {
  unsigned_tx?: string | null;
  wallet_hint?: string | null;
} & Pick<
  AttemptRow,
  'asset' | 'recipient' | 'reference' | 'amount_base' | 'mint' | 'issued_at'
>;
type ParsedShape = {
  blockTime?: number | null;
  meta?: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?:
      | {
          accountIndex: number;
          mint: string;
          owner?: string;
          uiTokenAmount: { amount: string };
        }[]
      | null;
    postTokenBalances?:
      | {
          accountIndex: number;
          mint: string;
          owner?: string;
          uiTokenAmount: { amount: string };
        }[]
      | null;
  } | null;
  transaction: {
    signatures?: string[];
    message: {
      accountKeys: { pubkey: unknown; signer: boolean }[];
      instructions: unknown[];
    };
  };
};
/** Require a signed, direct, exact-amount transfer and its actual balance effect. A reference is only an index. */
export function checkSponsorTransfer(
  raw: unknown,
  e: EvidenceFields,
): { payer: string; blockTime: number } | null {
  const tx = raw as ParsedShape;
  if (
    !tx?.meta ||
    tx.meta.err ||
    !tx.blockTime ||
    tx.blockTime * 1000 < e.issued_at - 5000
  )
    return null;
  const keys = tx.transaction.message.accountKeys.map((k) => ({
    key: String(k.pubkey),
    signer: k.signer,
  }));
  if (!keys.some((k) => k.key === e.reference) || !keys[0]?.signer) return null;
  // The stored ephemeral cosignature binds the entire issued message. Merely adding
  // this reference to an unrelated transfer (including a legacy purchase) earns nothing.
  if ('unsigned_tx' in e) {
    if (!e.unsigned_tx) return null;
    try {
      const expected = Transaction.from(Buffer.from(e.unsigned_tx, 'base64'));
      const guard = expected.signatures.find((item) => item.signature);
      if (!guard?.signature) return null;
      const index = keys.findIndex(
        (key) => key.key === guard.publicKey.toBase58() && key.signer,
      );
      if (
        index < 0 ||
        tx.transaction.signatures?.[index] !==
          getBase58Decoder().decode(guard.signature)
      )
        return null;
      if (e.wallet_hint && keys[0].key !== e.wallet_hint) return null;
    } catch {
      return null;
    }
  }
  const payer = keys[0].key;
  if (payer === e.recipient) return null;
  const required = BigInt(e.amount_base);
  for (const rawIx of tx.transaction.message.instructions) {
    const ix = rawIx as {
      programId?: unknown;
      parsed?: { type: string; info: Record<string, unknown> };
    };
    if (!ix.parsed) continue;
    const info = ix.parsed.info;
    if (
      !e.mint &&
      String(ix.programId) === '11111111111111111111111111111111' &&
      ix.parsed.type === 'transfer' &&
      info.source === payer &&
      info.destination === e.recipient &&
      typeof info.lamports === 'number' &&
      Number.isSafeInteger(info.lamports) &&
      BigInt(info.lamports) === required
    ) {
      const i = keys.findIndex((k) => k.key === e.recipient);
      if (
        i >= 0 &&
        BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]) >=
          required
      )
        return { payer, blockTime: tx.blockTime };
    }
    // A mint belongs to exactly one program, so the instruction's own program is what the
    // pair of accounts must be derived with; a transferChecked naming this mint under the
    // other program could not have executed.
    const program =
      String(ix.programId) === TOKEN_PROGRAM.toBase58()
        ? TOKEN_PROGRAM
        : String(ix.programId) === TOKEN_2022_PROGRAM.toBase58()
          ? TOKEN_2022_PROGRAM
          : null;
    if (
      e.mint &&
      program &&
      ix.parsed.type === 'transferChecked' &&
      info.authority === payer &&
      info.mint === e.mint
    ) {
      const amount = info.tokenAmount as { amount?: string } | undefined;
      if (amount?.amount !== e.amount_base) continue;
      const destination = ata(e.recipient, e.mint, program).toBase58();
      if (
        info.destination !== destination ||
        info.source !== ata(payer, e.mint, program).toBase58()
      )
        continue;
      const i = keys.findIndex((k) => k.key === destination);
      const pre = tx.meta.preTokenBalances?.find(
        (b) => b.accountIndex === i && b.mint === e.mint,
      );
      const post = tx.meta.postTokenBalances?.find(
        (b) =>
          b.accountIndex === i && b.mint === e.mint && b.owner === e.recipient,
      );
      if (
        post &&
        BigInt(post.uiTokenAmount.amount) -
          BigInt(pre?.uiTokenAmount.amount ?? '0') ===
          required
      )
        return { payer, blockTime: tx.blockTime };
    }
  }
  return null;
}
export async function verifySponsorSignature(
  c: Connection,
  signature: string,
  e: EvidenceFields,
) {
  let tx: ParsedTransactionWithMeta | null;
  try {
    tx = await c.getParsedTransaction(signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
  } catch {
    throw new SponsorError(
      503,
      'Payment verification is temporarily unavailable.',
      'RPC',
    );
  }
  const proof = checkSponsorTransfer(tx, e);
  return proof ? { ...proof, signature } : null;
}
export async function scanSponsorReference(
  c: Pick<Connection, 'getSignaturesForAddress' | 'getParsedTransaction'>,
  e: EvidenceFields & { scan_before: string | null },
  options: { pageSize?: number; maxPages?: number; deadlineAt?: number } = {},
) {
  const pageSize = options.pageSize ?? 25,
    maxPages = options.maxPages ?? 2,
    deadline = options.deadlineAt ?? Date.now() + 15000;
  let before = e.scan_before ?? undefined;
  const payments: { signature: string; payer: string; blockTime: number }[] =
    [];
  for (let i = 0; i < maxPages; i++) {
    if (Date.now() >= deadline)
      return { payments, complete: false, before: before ?? null };
    const page = await c.getSignaturesForAddress(
      new PublicKey(e.reference),
      { limit: pageSize, ...(before ? { before } : {}) },
      'finalized',
    );
    for (let offset = 0; offset < page.length; offset += 5) {
      if (Date.now() >= deadline)
        return { payments, complete: false, before: before ?? null };
      const chunk = page.slice(offset, offset + 5);
      const checked = await Promise.all(
        chunk.map(async (item) => ({
          item,
          tx: item.err
            ? undefined
            : await c.getParsedTransaction(item.signature, {
                commitment: 'finalized',
                maxSupportedTransactionVersion: 0,
              }),
        })),
      );
      for (const { item, tx } of checked) {
        if (!tx) continue;
        const proof = checkSponsorTransfer(tx, e);
        if (proof) payments.push({ ...proof, signature: item.signature });
      }
      // An indexed but temporarily unavailable body must be retried before moving the cursor.
      if (checked.some((value) => !value.item.err && !value.tx))
        return { payments, complete: false, before: before ?? null };
      before = chunk[chunk.length - 1].signature;
    }
    if (page.length < pageSize)
      return { payments, complete: true, before: null };
  }
  return { payments, complete: false, before: before ?? null };
}
