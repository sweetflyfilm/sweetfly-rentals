import { json, fail, timingSafeEqual, siteUrl } from '../../_lib/http.js';
import { todayDenver } from '../../../pricing.js';

// GET /api/reminders/charges-due - read-only list for the n8n morning reminder: insured bookings that are
// confirmed but not charged yet and whose pickup is tomorrow (or already today / overdue, or a charge failed).
// Uses its own REMINDER_TOKEN so n8n never holds the admin token that can charge cards.
export async function onRequestGet({ request, env }) {
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.REMINDER_TOKEN || !given || !timingSafeEqual(given, env.REMINDER_TOKEN)) return fail(401, 'unauthorized');
  const today = todayDenver();
  const tomorrow = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) + 864e5).toISOString().slice(0, 10);
  const { results } = await env.DB
    .prepare(`SELECT id, name, email, start_date, end_date, total_cents, charge_error FROM bookings
              WHERE status = 'confirmed' AND start_date <= ?1 ORDER BY start_date`)
    .bind(tomorrow).all();
  return json({ date: today, admin_url: `${siteUrl(request, env)}/admin.html`, due: results });
}
