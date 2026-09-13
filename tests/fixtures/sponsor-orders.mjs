// Cap orders for the sponsorship tests: an order with a quote, and one paid at a given moment.
// `db` is the test's own build of lib/sponsor-db, so the fixture never builds a second copy.
export const capDraft = (target) => ({
  product: 'cap',
  target,
  name: 'Joe',
  projectName: 'GM',
  message: 'Builders ship',
  assetId: 'art',
});
export const capAttempt = (db, d, id, order) =>
  db.insertAttempt(d, {
    id,
    order_id: order,
    pay_token: id,
    asset: 'SOL',
    mint: null,
    decimals: 9,
    amount_base: '1000000000',
    price_usd: '100',
    price_cents: 10000,
    recipient: 'treasury',
    reference: id,
    issued_at: 100,
    expires_at: 200,
  });
/** A cap order for one host with an open quote `${id}-a`. */
export async function capOrder(db, d, id, target) {
  await db.createOrder(d, { id, tokenHash: id, draft: capDraft(target), now: 100 });
  await capAttempt(db, d, `${id}-a`, id);
}
/** A cap order for one host, paid at the given moment. */
export async function paidCap(db, d, id, target, at) {
  await capOrder(db, d, id, target);
  await db.settlePayment(
    d,
    `${id}-a`,
    { signature: `sig-${id}`, payer: 'payer', blockTime: 150 },
    at,
  );
}
