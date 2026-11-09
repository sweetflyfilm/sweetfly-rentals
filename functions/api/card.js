import { json, fail, siteUrl } from '../_lib/http.js';
import { stripe } from '../_lib/stripe.js';

// POST {id, t} - the renter's card was declined at charge time and they want to give us a new one.
// Returns {url}: a Stripe page that only saves a card (nothing is charged). The webhook swaps it in
// (checkout.session.completed, mode setup) and emails Grant, who then charges again.
export async function onRequestPost({ request, env }) {
  const { id, t } = await request.json().catch(() => ({}));
  const row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?1 AND token = ?2').bind(id || '', t || '').first();
  if (!row) return fail(404, 'not_found', 'We can’t find that booking.');
  if (row.status !== 'confirmed' || !row.customer_id) return fail(409, 'no_card_change', 'There is nothing to update on this booking.');
  const status = `${siteUrl(request, env)}/thanksbooking.html?b=${row.id}&t=${row.token}`;
  try {
    const session = await stripe(env, 'POST', 'checkout/sessions', {
      mode: 'setup',
      payment_method_types: ['card'],
      customer: row.customer_id,
      client_reference_id: row.id,
      success_url: status,
      cancel_url: status,
      metadata: { booking_id: row.id, kind: 'card_update' }
    });
    return json({ url: session.url });
  } catch (err) {
    console.error('card update session failed', row.id, err.message);
    return fail(502, 'card_failed', 'We couldn’t open the card page. Please try again in a minute.');
  }
}
