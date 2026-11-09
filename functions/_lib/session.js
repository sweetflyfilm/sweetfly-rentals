import { catalog } from './catalog.js';
import { stripe } from './stripe.js';

const stripeLine = (name, cents, description) => ({
  quantity: 1,
  price_data: { currency: 'usd', unit_amount: cents, product_data: { name, ...(description ? { description } : {}) } }
});

// One Stripe Checkout session that only HOLDS the card (manual capture). Used for the first request and,
// if Grant's amended order costs more than the original hold, for the renter's one extra card step.
// `q` is a pricing.js quote; nothing here trusts the browser.
// `q.deferred` (insurance on file): the card is also saved so Grant can charge it the day before pickup,
// because a card hold only lasts about 7 days.
export async function createHoldSession(env, { id, token, email, site, q, start, end, holdSec = 31 * 60, cancelUrl }) {
  const when = `${start} to ${end} (${q.days} ${q.days === 1 ? 'day' : 'days'})`;
  const lineItems = q.lines.map((l) => stripeLine(`${l.qty} x ${l.name}`, l.cents, when));
  if (q.waiver) lineItems.push(stripeLine('Damage waiver', q.waiver, 'Caps your liability for accidental damage. Not insurance.'));
  if (q.tax) lineItems.push(stripeLine(`Sales tax (${(catalog.taxRate * 100).toFixed(2)}%)`, q.tax));
  if (q.deposit) lineItems.push(stripeLine('Refundable security deposit', q.deposit, 'Returned after the gear comes back clean.'));

  return stripe(env, 'POST', 'checkout/sessions', {
    mode: 'payment',
    submit_type: 'book',
    payment_method_types: ['card'], // card holds only; Klarna, Affirm and Cash App can't be held and approved later
    custom_text: { submit: { message: q.deferred
      ? 'Your card is only held, not charged. We confirm the gear is free for your dates, then charge the full amount the day before pickup. If we can’t, the hold is released.'
      : 'Your card is only held, not charged. We charge it once we confirm the gear is free for your dates. If we can’t, the hold is released.' } },
    client_reference_id: id,
    customer_email: email,
    ...(q.deferred ? { customer_creation: 'always' } : {}),
    line_items: lineItems,
    success_url: `${site}/thanksbooking.html?b=${id}&t=${token}`,
    cancel_url: cancelUrl || `${site}/checkout.html?cancelled=1`,
    expires_at: Math.floor(Date.now() / 1000) + holdSec,
    metadata: { booking_id: id },
    payment_intent_data: {
      capture_method: 'manual', // authorize now, capture when Grant approves (or at pickup if insured)
      ...(q.deferred ? { setup_future_usage: 'off_session' } : {}),
      description: `SweetFly Shop rental ${id}`,
      metadata: { booking_id: id, deposit_cents: q.deposit }
    }
  });
}
