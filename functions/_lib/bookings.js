import { catalog } from './catalog.js';
import { stripe } from './stripe.js';
import { indexItems, unavailableItems } from '../../pricing.js';

// What holds stock: approved bookings (confirmed / paid / picked_up) and the dates Grant blocks by hand.
// Requests that are still waiting for approval do NOT hold anything; Grant decides those.
// A booking holds the gear from its pickup day up to (not including) its return day.
export async function holdingBookings(db, start, end) {
  const { results } = await db
    .prepare(`SELECT id, start_date, end_date, items_json FROM bookings
              WHERE start_date < ?2 AND end_date > ?1 AND status IN ('confirmed','paid','picked_up')`)
    .bind(start, end)
    .all();
  const blocks = await db
    .prepare('SELECT id, item_id, start_date, end_date FROM blocks WHERE start_date < ?2 AND end_date > ?1')
    .bind(start, end)
    .all();
  return [
    ...results.map((r) => ({ id: r.id, start_date: r.start_date, end_date: r.end_date, items: JSON.parse(r.items_json) })),
    ...blocks.results.map((b) => ({ id: `block-${b.id}`, start_date: b.start_date, end_date: b.end_date, items: { [b.item_id]: 1 } }))
  ];
}

export async function unavailableFor(db, items, start, end, ignoreId) {
  const held = (await holdingBookings(db, start, end)).filter((b) => b.id !== ignoreId);
  return unavailableItems(catalog, items, start, end, held);
}

// Insured renters (certificate on file) pay nothing at approval: status 'confirmed' until Grant charges the
// saved card the day before pickup ('Charge now'). Everyone else is charged when Grant approves.
export const chargesAtPickup = (row) => !!row.has_coi;

const SHOP = 'https://shop.sweetflyfilm.com';
const names = indexItems(catalog);
const linesOf = (items) => Object.entries(items || {}).filter(([, q]) => q).map(([id, qty]) => ({ id, qty, name: names[id]?.name || id }));

// What the n8n email flow receives: the booking, readable item lines, and the links the emails need.
export function eventPayload(env, row) {
  const site = (env.SITE_URL || SHOP).replace(/\/$/, '');
  const offer = row.offer_json ? JSON.parse(row.offer_json) : null;
  return {
    ...adminBooking(row),
    charge_at_pickup: chargesAtPickup(row),
    lines: linesOf(JSON.parse(row.items_json || '{}')),
    offer: offer && { ...offer, lines: linesOf(offer.items) },
    status_url: `${site}/thanksbooking.html?b=${row.id}&t=${row.token}`,
    admin_url: `${site}/admin.html`
  };
}

// Best-effort ping to n8n (or anything) so Grant and the renter get emails. Never blocks the response.
// Pass the raw DB row; the renter's secret link is added here and only goes to your own n8n.
export async function notify(env, type, row) {
  if (!env.NOTIFY_WEBHOOK_URL) return;
  const booking = eventPayload(env, row);
  try {
    await fetch(env.NOTIFY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': env.NOTIFY_WEBHOOK_SECRET || '' },
      body: JSON.stringify({ type, booking })
    });
  } catch { /* notification is optional */ }
}

// The card is held (not charged) once the PaymentIntent reaches requires_capture.
// Idempotent: the webhook and the status page can both call this; only the first one flips the row.
export async function markRequested(env, id, pi) {
  const now = new Date();
  const respondBy = new Date(now.getTime() + 6 * 864e5).toISOString(); // card holds last 7 days
  const res = await env.DB
    .prepare(`UPDATE bookings SET status = 'requested', authorized_at = ?2, payment_intent = ?3, expires_at = ?4,
              customer_id = ?5, payment_method_id = ?6
              WHERE id = ?1 AND status = 'pending'`)
    .bind(id, now.toISOString(), pi?.id || null, respondBy, pi?.customer || null, pi?.payment_method || null)
    .run();
  if (!res.meta.changes) return false;
  const row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
  await notify(env, 'booking.requested', row);
  return true;
}

// Ask Stripe whether a Checkout session ended with the card held. Returns the PaymentIntent (or null).
export async function heldPaymentIntent(env, sessionId) {
  const s = await stripe(env, 'GET', `checkout/sessions/${sessionId}`);
  if (s.status !== 'complete' || !s.payment_intent) return null;
  const pi = await stripe(env, 'GET', `payment_intents/${s.payment_intent}`);
  return ['requires_capture', 'succeeded'].includes(pi.status) ? pi : null;
}

export const publicBooking = (r) => ({
  id: r.id, status: r.status, name: r.name, email: r.email,
  start: r.start_date, end: r.end_date, days: r.days,
  subtotal_cents: r.subtotal_cents, waiver_cents: r.waiver_cents, tax_cents: r.tax_cents,
  deposit_cents: r.deposit_cents, total_cents: r.total_cents,
  has_coi: !!r.has_coi, identity_status: r.identity_status, decline_reason: r.decline_reason,
  offer: r.offer_json ? (({ items, ...o }) => ({ ...o, lines: linesOf(items) }))(JSON.parse(r.offer_json)) : null,
  held_cents: r.total_cents,
  charge_at_pickup: chargesAtPickup(r),
  charge_failed: r.status === 'confirmed' && !!r.charge_error
});

// Everything except the renter's secret token.
export const adminBooking = (r) => {
  const { token, ...rest } = r;
  return { ...rest, items: JSON.parse(r.items_json || '{}') };
};

// Turns the stored amended order into the booking. Shared by "accept" and "accept after re-authorizing".
const APPLY_OFFER = `UPDATE bookings SET status = ?13, paid_at = ?2, items_json = ?3, start_date = ?4, end_date = ?5, days = ?6,
  subtotal_cents = ?7, waiver_cents = ?8, tax_cents = ?9, deposit_cents = ?10, total_cents = ?11,
  offer_json = NULL, offer_session_id = NULL, payment_intent = ?12,
  customer_id = COALESCE(?14, customer_id), payment_method_id = COALESCE(?15, payment_method_id)
  WHERE id = ?1 AND status = 'offered'`;

// Insured: the accepted order is just confirmed (charged later). Others: charged now, so 'paid'.
async function applyOffer(env, row, offer, pi) {
  const deferred = chargesAtPickup(row);
  const res = await env.DB.prepare(APPLY_OFFER)
    .bind(row.id, deferred ? null : new Date().toISOString(), JSON.stringify(offer.items), offer.start, offer.end, offer.days,
      offer.subtotal, offer.waiver, offer.tax, offer.deposit, offer.dueNow, pi.id, deferred ? 'confirmed' : 'paid',
      pi.customer || null, pi.payment_method || null)
    .run();
  return res.meta.changes > 0;
}

// Renter accepted an amended order that costs no more than the card hold: capture the lower amount.
// Stripe releases the rest of the hold by itself.
export async function acceptOfferCaptureLess(env, row) {
  const offer = JSON.parse(row.offer_json);
  if (!chargesAtPickup(row)) {
    await stripe(env, 'POST', `payment_intents/${row.payment_intent}/capture`, { amount_to_capture: offer.dueNow }, `accept-${row.id}-${offer.dueNow}`);
  }
  if (await applyOffer(env, row, offer, { id: row.payment_intent })) {
    await notify(env, 'booking.offer_accepted', await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(row.id).first());
    return true;
  }
  return false;
}

// Renter re-authorized for a costlier amended order: capture the new hold (insured: keep it, the charge
// comes at pickup), drop the old one.
export async function finalizeOfferSession(env, row) {
  const pi = await heldPaymentIntent(env, row.offer_session_id);
  if (!pi) return false;
  const offer = JSON.parse(row.offer_json);
  if (!chargesAtPickup(row)) {
    await stripe(env, 'POST', `payment_intents/${pi.id}/capture`, { amount_to_capture: offer.dueNow }, `reauth-${row.id}-${pi.id}`);
  }
  const oldPi = row.payment_intent;
  if (!(await applyOffer(env, row, offer, pi))) return false;
  if (oldPi && oldPi !== pi.id) await stripe(env, 'POST', `payment_intents/${oldPi}/cancel`, {}, `cancel-old-${row.id}`).catch(() => {});
  await notify(env, 'booking.offer_accepted', await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(row.id).first());
  return true;
}

// Charge a confirmed (insured) booking, the day before pickup. If Stripe still has the original card hold
// we capture it; otherwise (holds only last ~7 days) we charge the saved card off-session.
// Returns the PaymentIntent id that holds the money. Throws Stripe's message if the card fails.
export async function chargeConfirmed(env, row) {
  const tag = `${row.total_cents}-${row.payment_method_id || 'x'}-${row.charge_failed_at || '0'}`; // new key after each failure
  let held = null;
  if (row.payment_intent) held = await stripe(env, 'GET', `payment_intents/${row.payment_intent}`).catch(() => null);
  if (held && held.status === 'requires_capture') {
    await stripe(env, 'POST', `payment_intents/${held.id}/capture`, { amount_to_capture: row.total_cents }, `capture-${row.id}-${tag}`);
    return held.id;
  }
  if (!row.customer_id || !row.payment_method_id) throw new Error('There is no saved card on this booking.');
  const pi = await stripe(env, 'POST', 'payment_intents', {
    amount: row.total_cents,
    currency: 'usd',
    customer: row.customer_id,
    payment_method: row.payment_method_id,
    off_session: true,
    confirm: true,
    description: `SweetFly Shop rental ${row.id}`,
    metadata: { booking_id: row.id }
  }, `charge-${row.id}-${tag}`);
  if (pi.status !== 'succeeded') throw new Error('The card needs extra approval from the renter.');
  return pi.id;
}
