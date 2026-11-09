import { json } from '../_lib/http.js';
import { unavailableFor } from '../_lib/bookings.js';
import { catalog } from '../_lib/catalog.js';
import { daysBetween, isIsoDate } from '../../pricing.js';

// GET /api/availability?start=YYYY-MM-DD&end=YYYY-MM-DD&items=generator:1,canopy:2
export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  const start = q.get('start'), end = q.get('end');
  const days = daysBetween(start, end);
  if (!isIsoDate(start) || !isIsoDate(end) || !days || days > catalog.maxDays) return json({ unavailable: [] });
  const items = {};
  for (const part of (q.get('items') || '').split(',')) {
    const [id, n] = part.split(':');
    if (id && Number(n) > 0) items[id] = Math.min(20, Math.floor(Number(n)));
  }
  return json({ unavailable: await unavailableFor(env.DB, items, start, end) });
}
