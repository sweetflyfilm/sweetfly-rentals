import { json, requireAdmin } from '../../_lib/http.js';
import { adminBooking } from '../../_lib/bookings.js';

// GET /api/admin/bookings - newest pickups first. Unpaid/expired carts are hidden unless ?all=1.
export async function onRequestGet({ request, env }) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;
  const all = new URL(request.url).searchParams.get('all') === '1';
  const { results } = await env.DB
    .prepare(`SELECT * FROM bookings ${all ? '' : `WHERE status NOT IN ('pending','expired')`} ORDER BY start_date DESC, created_at DESC LIMIT 200`)
    .all();
  return json({ bookings: results.map(adminBooking) });
}
