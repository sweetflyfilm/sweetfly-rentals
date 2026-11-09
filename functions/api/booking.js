import { json, fail } from '../_lib/http.js';
import { finalizeOfferSession, heldPaymentIntent, markRequested, publicBooking } from '../_lib/bookings.js';

// GET /api/booking?id=...&t=... - what the renter's status page shows. The token is the password.
export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  const id = q.get('id') || '', t = q.get('t') || '';
  let row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?1 AND token = ?2').bind(id, t).first();
  if (!row) return fail(404, 'not_found', 'We can’t find that booking.');

  // The webhook normally flips this a second after the card is held. If the renter beat it back to
  // the site, ask Stripe directly so the page doesn't sit on "waiting".
  if (row.status === 'pending' && row.stripe_session_id) {
    try {
      const pi = await heldPaymentIntent(env, row.stripe_session_id);
      if (pi) {
        await markRequested(env, id, pi);
        row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
      }
    } catch (err) { console.error('session check failed', err.message); }
  }
  // Renter came back from the extra card step for an amended order before the webhook landed.
  if (row.status === 'offered' && row.offer_session_id) {
    try {
      if (await finalizeOfferSession(env, row)) row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
    } catch (err) { console.error('offer session check failed', err.message); }
  }
  return json(publicBooking(row));
}
