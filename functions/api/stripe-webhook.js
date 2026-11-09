import { json, fail } from '../_lib/http.js';
import { stripe, verifyWebhook } from '../_lib/stripe.js';
import { finalizeOfferSession, markRequested, notify } from '../_lib/bookings.js';

// Stripe Dashboard -> Developers -> Webhooks -> https://shop.sweetflyfilm.com/api/stripe-webhook
// Events: checkout.session.completed, checkout.session.expired, payment_intent.canceled,
//         identity.verification_session.verified, identity.verification_session.requires_input
export async function onRequestPost({ request, env }) {
  const raw = await request.text();
  if (!(await verifyWebhook(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return fail(400, 'bad_signature');
  }
  const event = JSON.parse(raw);
  const obj = event.data.object;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        // A renter replacing a declined card (setup-mode session, see api/card.js).
        if (obj.mode === 'setup' && obj.metadata?.kind === 'card_update') {
          const si = await stripe(env, 'GET', `setup_intents/${obj.setup_intent}`);
          if (!si.payment_method) break;
          const res = await env.DB.prepare(`UPDATE bookings SET payment_method_id = ?2, charge_error = NULL WHERE id = ?1 AND status = 'confirmed'`)
            .bind(obj.metadata.booking_id, si.payment_method).run();
          if (res.meta.changes) await notify(env, 'booking.card_updated', await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(obj.metadata.booking_id).first());
          break;
        }
        // Manual capture: the session completes with the card held, not charged.
        if (!obj.payment_intent) break;
        const cur = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(obj.client_reference_id).first();
        if (cur && cur.status === 'offered' && cur.offer_session_id === obj.id) { await finalizeOfferSession(env, cur); break; }
        const pi = await stripe(env, 'GET', `payment_intents/${obj.payment_intent}`);
        if (['requires_capture', 'succeeded'].includes(pi.status)) await markRequested(env, obj.client_reference_id, pi);
        break;
      }

      case 'checkout.session.expired':
        await env.DB.prepare(`UPDATE bookings SET status = 'expired' WHERE id = ?1 AND status = 'pending'`)
          .bind(obj.client_reference_id).run();
        break;

      case 'payment_intent.canceled': {
        // Fires when we decline (we already set 'declined') or when Stripe drops a hold after ~7 days.
        const id = obj.metadata?.booking_id;
        if (!id) break;
        const res = await env.DB.prepare(`UPDATE bookings SET status = 'expired' WHERE id = ?1 AND status IN ('requested','offered') AND payment_intent = ?2`).bind(id, obj.id).run();
        if (res.meta.changes) {
          const row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
          await notify(env, 'booking.expired', row);
        }
        break;
      }

      case 'identity.verification_session.verified': {
        const id = obj.metadata?.booking_id;
        if (!id) break;
        let idName = null;
        try {
          const full = await stripe(env, 'GET', `identity/verification_sessions/${obj.id}`, { expand: ['verified_outputs'] });
          const v = full.verified_outputs;
          if (v) idName = [v.first_name, v.last_name].filter(Boolean).join(' ') || null;
        } catch (err) { console.error('verified_outputs unavailable', err.message); }
        await env.DB.prepare(`UPDATE bookings SET identity_status = 'verified', identity_name = ?2 WHERE id = ?1`)
          .bind(id, idName).run();
        const row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
        if (row) await notify(env, 'booking.id_verified', row);
        break;
      }

      case 'identity.verification_session.requires_input': {
        const id = obj.metadata?.booking_id;
        if (!id) break;
        await env.DB.prepare(`UPDATE bookings SET identity_status = 'failed' WHERE id = ?1 AND identity_status != 'verified'`)
          .bind(id).run();
        const row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
        if (row) await notify(env, 'booking.id_failed', row);
        break;
      }
    }
  } catch (err) {
    console.error('webhook handler failed', event.type, err.message);
    return fail(500, 'handler_failed'); // Stripe retries
  }
  return json({ received: true });
}
