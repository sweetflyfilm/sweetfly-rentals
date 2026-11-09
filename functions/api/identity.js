import { json, fail, siteUrl } from '../_lib/http.js';
import { stripe } from '../_lib/stripe.js';

// POST {id, t} -> {url} for Stripe's hosted ID check (driver's license/passport + selfie).
// Stripe keeps the images; we only store the result.
export async function onRequestPost({ request, env }) {
  const { id, t } = await request.json().catch(() => ({}));
  const row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?1 AND token = ?2').bind(id || '', t || '').first();
  if (!row) return fail(404, 'not_found', 'We can’t find that booking.');
  if (!['requested', 'paid', 'picked_up'].includes(row.status)) return fail(409, 'not_requested', 'Finish the card step first.');
  if (row.identity_status === 'verified') return json({ verified: true });

  try {
    const session = await stripe(env, 'POST', 'identity/verification_sessions', {
      type: 'document',
      options: { document: { require_matching_selfie: true, allowed_types: ['driving_license', 'passport', 'id_card'] } },
      provided_details: { email: row.email },
      metadata: { booking_id: row.id },
      return_url: `${siteUrl(request, env)}/thanksbooking.html?b=${row.id}&t=${row.token}&idv=1`
    });
    await env.DB.prepare(`UPDATE bookings SET identity_session_id = ?2, identity_status = 'pending' WHERE id = ?1`)
      .bind(row.id, session.id).run();
    return json({ url: session.url });
  } catch (err) {
    console.error('identity start failed', row.id, err.message);
    return fail(502, 'identity_failed', 'We couldn’t start the ID check. Please try again in a minute.');
  }
}
