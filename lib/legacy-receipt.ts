export const legacyReceiptKey = 'interact:receipt';
export function readLegacyReceipt(raw: string | null) {
  try {
    const r = JSON.parse(raw || 'null') as {
      reference?: unknown;
      from?: unknown;
      wallet?: unknown;
      signature?: unknown;
      paid?: unknown;
      at?: unknown;
    } | null;
    if (
      !r ||
      typeof r.reference !== 'string' ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.reference)
    )
      return null;
    return {
      reference: r.reference,
      from: typeof r.from === 'string' ? r.from : 'a viewer',
      wallet: typeof r.wallet === 'string' ? r.wallet : '',
      signature: typeof r.signature === 'string' ? r.signature : null,
      paid: r.paid === true,
      at: typeof r.at === 'number' ? r.at : 0,
    };
  } catch {
    return null;
  }
}
