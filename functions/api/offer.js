import { json, fail, siteUrl } from '../_lib/http.js';
import { stripe } from '../_lib/stripe.js';
import { createHoldSession } from '../_lib/session.js';
import { acceptOfferCaptureLess, notify, unavailableFor } from '../_lib/bookings.js';
import { catalog } from '../_lib/catalog.js';
import { quote } from '../../pricing.js';

// POST {id, t, action: 'accept' | 'decline'} - the renter's answer to Grant's amended order.
// The renter's card, ID and insurance are already on file, so accepting is one tap.
//   amended order <= what is held   -> captures the lower amount, done
//   amended order  > what is held   -> returns {url} for ONE new card-hold step, then it finishes itself
export async function onRequestPost({ request, env }) {
  const { id, t, action } = await request.json().catch(() => ({}));
  const row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?1 AND token = ?2').bind(id || '', t || '').first();
  if (!row) return fail(404, 'not_found', 'We can’t find that booking.');
  if (row.status !== 'offered' || !row.offer_json) return fail(409, 'no_offer', 'There is no change waiting for your answer.');
  const offer = JSON.parse(row.offer_json);

  if (action === 'decline') {
    try { await stripe(env, 'POST', `payment_intents/${row.payment_intent}/cancel`, {}, `cancel-${row.id}`); }
    catch (err) { return fail(502, 'release_failed', 'We couldn’t release your card hold. Please email us.'); }
    await env.DB.prepare(`UPDATE bookings SET status = 'declined', decline_reason = 'You declined the amended order.', offer_json = NULL WHERE id = ?`).bind(row.id).run();
    await notify(env, 'booking.offer_declined', await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(row.id).first());
    return json({ status: 'declined' });
  }
  if (action !== 'accept') return fail(400, 'bad_action');

  // Gear may have been booked since Grant made the offer.
  const clash = await unavailableFor(env.DB, offer.items, offer.start, offer.end, row.id);
  if (clash.length) return fail(409, 'unavailable', 'Sorry, some of that gear was just booked for those dates. We’ll be in touch.');

  if (offer.mode === 'capture_less') {
    try { await acceptOfferCaptureLess(env, row); }
    catch (err) { console.error('accept failed', row.id, err.message); return fail(502, 'capture_failed', 'We couldn’t complete that. Please try again in a minute.'); }
    return json({ status: 'paid' });
  }

  // Costs more than the held amount: one new card hold for the new total.
  const q = quote(catalog, { items: offer.items, start: offer.start, end: offer.end, hasCoi: !!row.has_coi });
  if (!q.ok || q.dueNow !== offer.dueNow) return fail(409, 'changed', 'Prices changed since this offer was sent. We’ll send an updated one.');
  try {
    const site = siteUrl(request, env);
    const session = await createHoldSession(env, {
      id: row.id, token: row.token, email: row.email, site, q, start: offer.start, end: offer.end,
      cancelUrl: `${site}/thanksbooking.html?b=${row.id}&t=${row.token}`
    });
    await env.DB.prepare('UPDATE bookings SET offer_session_id = ?2 WHERE id = ?1').bind(row.id, session.id).run();
    return json({ url: session.url });
  } catch (err) {
    console.error('offer session failed', row.id, err.message);
    return fail(502, 'checkout_failed', 'We couldn’t start the card step. Please try again in a minute.');
  }
}
