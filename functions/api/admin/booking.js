import { json, fail, requireAdmin } from '../../_lib/http.js';
import { stripe } from '../../_lib/stripe.js';
import { adminBooking, chargeConfirmed, chargesAtPickup, notify, unavailableFor } from '../../_lib/bookings.js';
import { quote, todayDenver } from '../../../pricing.js';
import { catalog } from '../../_lib/catalog.js';

const STATUS_ACTIONS = { picked_up: 'picked_up', returned: 'returned', cancel: 'cancelled' };
const fresh = (env, id) => env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();

// POST {id, action, amountCents?, note?, reason?, force?}
//   approve                          -> charges the held card (rental + tax + waiver + deposit).
//                                       Insured renters are only confirmed (no charge); charge them the day before pickup.
//                                       Refuses if the gear overlaps another confirmed booking or a block, unless force.
//   charge                           -> insured, confirmed: charge the saved card now (capture the hold, or off-session)
//   amend {items, start, end, note}  -> counter-offer (e.g. 3 of the 4 days); renter accepts or declines from their link
//   decline                          -> releases the hold, nothing is charged (reason is shown to the renter)
//   picked_up | returned | cancel    -> status only (cancel does NOT refund; refund separately)
//   id_in_person                     -> you checked their ID at the counter
//   refund_deposit                   -> refunds the deposit (default: whatever is left of it)
//   refund_other                     -> refunds rental money, e.g. a cancellation (amountCents required)
//   note                             -> saves a note (damage, late fee, etc.)
export async function onRequestPost({ request, env }) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;
  const { id, action, amountCents, note, reason, force, items, start, end } = await request.json().catch(() => ({}));
  const row = await fresh(env, id || '');
  if (!row) return fail(404, 'not_found');

  if (action === 'approve') {
    if (row.status !== 'requested') return fail(409, 'not_requested', 'Only requests waiting for approval can be approved. If you sent an amended offer, wait for the renter or revise it.');
    if (!force) {
      const items = JSON.parse(row.items_json);
      const clash = await unavailableFor(env.DB, items, row.start_date, row.end_date, row.id);
      if (clash.length) return json({ error: 'conflict', message: 'These items overlap a confirmed booking or a blocked date.', conflicts: clash }, 409);
    }
    if (chargesAtPickup(row)) {
      // Insured: lock in the dates, charge the saved card later.
      await env.DB.prepare(`UPDATE bookings SET status = 'confirmed' WHERE id = ?1 AND status = 'requested'`).bind(id).run();
      await notify(env, 'booking.confirmed', await fresh(env, id));
    } else {
      try {
        await stripe(env, 'POST', `payment_intents/${row.payment_intent}/capture`, {}, `capture-${row.id}`);
      } catch (err) { return fail(502, 'capture_failed', err.message); }
      await env.DB.prepare(`UPDATE bookings SET status = 'paid', paid_at = ?2 WHERE id = ?1`).bind(id, new Date().toISOString()).run();
      await notify(env, 'booking.approved', await fresh(env, id));
    }
  } else if (action === 'charge') {
    if (row.status !== 'confirmed') return fail(409, 'not_confirmed', 'Only a confirmed booking that has not been charged can be charged.');
    let piId;
    try { piId = await chargeConfirmed(env, row); }
    catch (err) {
      const message = String(err.message).replace(/^Stripe \d+: /, '');
      await env.DB.prepare('UPDATE bookings SET charge_error = ?2, charge_failed_at = ?3 WHERE id = ?1').bind(id, message, new Date().toISOString()).run();
      await notify(env, 'booking.charge_failed', await fresh(env, id));
      return fail(402, 'charge_failed', message);
    }
    await env.DB.prepare(`UPDATE bookings SET status = 'paid', paid_at = ?2, payment_intent = ?3, charge_error = NULL WHERE id = ?1 AND status = 'confirmed'`)
      .bind(id, new Date().toISOString(), piId).run();
    await notify(env, 'booking.charged', await fresh(env, id));
  } else if (action === 'cancel' && row.status === 'confirmed') {
    // Nothing was charged; let go of the card hold if Stripe still has it.
    if (row.payment_intent) await stripe(env, 'POST', `payment_intents/${row.payment_intent}/cancel`, {}, `cancel-${row.id}`).catch(() => {});
    await env.DB.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?1`).bind(id).run();
  } else if (action === 'amend') {
    // Counter-offer: change dates and/or items. The renter accepts or declines from their status link
    // without re-entering anything; their card, ID and insurance stay on file.
    if (!['requested', 'offered'].includes(row.status)) return fail(409, 'not_requested', 'Only waiting requests can be amended.');
    const q = quote(catalog, { items, start, end, hasCoi: !!row.has_coi, today: todayDenver() });
    if (!q.ok) return fail(400, q.errors[0].code, q.errors[0].message);
    const newItems = Object.fromEntries(q.lines.map((l) => [l.id, l.qty]));
    if (!force) {
      const clash = await unavailableFor(env.DB, newItems, start, end, row.id);
      if (clash.length) return json({ error: 'conflict', message: 'These items overlap a confirmed booking or a blocked date.', conflicts: clash }, 409);
    }
    // Under the amount already held: capture the lower amount, nothing to re-enter. Over it: they re-authorize once.
    const mode = q.dueNow <= row.total_cents ? 'capture_less' : 'reauthorize';
    const offer = { items: newItems, start, end, days: q.days, subtotal: q.subtotal, waiver: q.waiver, tax: q.tax, deposit: q.deposit, dueNow: q.dueNow, mode, note: String(note || '').slice(0, 1000) };
    await env.DB.prepare(`UPDATE bookings SET status = 'offered', offer_json = ?2, offer_session_id = NULL, offered_at = ?3 WHERE id = ?1`)
      .bind(id, JSON.stringify(offer), new Date().toISOString()).run();
    await notify(env, 'booking.offered', await fresh(env, id));
  } else if (action === 'decline') {
    if (!['requested', 'offered'].includes(row.status)) return fail(409, 'not_requested', 'Only requests waiting for approval can be declined.');
    try {
      await stripe(env, 'POST', `payment_intents/${row.payment_intent}/cancel`, {}, `cancel-${row.id}`);
    } catch (err) { return fail(502, 'release_failed', err.message); }
    await env.DB.prepare(`UPDATE bookings SET status = 'declined', decline_reason = ?2 WHERE id = ?1`)
      .bind(id, String(reason || '').slice(0, 500)).run();
    await notify(env, 'booking.declined', await fresh(env, id));
  } else if (STATUS_ACTIONS[action]) {
    await env.DB.prepare('UPDATE bookings SET status = ?2 WHERE id = ?1').bind(id, STATUS_ACTIONS[action]).run();
  } else if (action === 'id_in_person') {
    await env.DB.prepare(`UPDATE bookings SET identity_status = 'verified', identity_name = 'Checked in person' WHERE id = ?`).bind(id).run();
  } else if (action === 'note') {
    await env.DB.prepare('UPDATE bookings SET admin_note = ?2 WHERE id = ?1').bind(id, String(note || '').slice(0, 2000)).run();
  } else if (action === 'refund_deposit' || action === 'refund_other') {
    if (!row.paid_at || !row.payment_intent) return fail(409, 'not_charged', 'Only a charged booking can be refunded. To release a hold, decline it.');
    const isDeposit = action === 'refund_deposit';
    const left = isDeposit
      ? row.deposit_cents - row.deposit_refunded_cents
      : row.total_cents - row.deposit_cents - row.other_refunded_cents;
    const amount = Math.floor(Number(amountCents ?? (isDeposit ? left : 0)));
    if (!(amount > 0) || amount > left) return fail(400, 'amount', `Amount must be between 1 cent and ${left} cents.`);
    const sofar = isDeposit ? row.deposit_refunded_cents : row.other_refunded_cents;
    try {
      await stripe(env, 'POST', 'refunds', {
        payment_intent: row.payment_intent,
        amount,
        metadata: { booking_id: id, kind: isDeposit ? 'deposit' : 'rental' }
      }, `refund-${id}-${action}-${sofar}-${amount}`);
    } catch (err) { return fail(502, 'refund_failed', err.message); }
    const col = isDeposit ? 'deposit_refunded_cents' : 'other_refunded_cents';
    await env.DB.prepare(`UPDATE bookings SET ${col} = ${col} + ?2 WHERE id = ?1`).bind(id, amount).run();
  } else {
    return fail(400, 'bad_action');
  }

  return json({ booking: adminBooking(await fresh(env, id)) });
}
