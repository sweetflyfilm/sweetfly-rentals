import { json, fail, requireAdmin } from '../../_lib/http.js';
import { catalog } from '../../_lib/catalog.js';
import { indexItems, isIsoDate } from '../../../pricing.js';

// Dates Grant blocks by hand (a ShareGrid booking, a shoot, repairs). Blocking an item also blocks
// every package that contains it, because availability is counted by the gear underneath.
//   GET                                -> {blocks: [...]}
//   POST {item_id, start, end, note}   -> start = first night held, end = return day (before noon)
//   DELETE ?id=                        -> removes one
export async function onRequestGet({ request, env }) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;
  const { results } = await env.DB.prepare(`SELECT * FROM blocks WHERE end_date >= ? ORDER BY start_date`)
    .bind(new Date().toISOString().slice(0, 10)).all();
  return json({ blocks: results });
}

export async function onRequestPost({ request, env }) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;
  const { item_id, start, end, note } = await request.json().catch(() => ({}));
  if (!indexItems(catalog)[item_id]) return fail(400, 'item', 'Pick an item.');
  if (!isIsoDate(start) || !isIsoDate(end) || end <= start) return fail(400, 'dates', 'End (return day) must be after start.');
  await env.DB.prepare('INSERT INTO blocks (item_id, start_date, end_date, note, created_at) VALUES (?1,?2,?3,?4,?5)')
    .bind(item_id, start, end, String(note || '').slice(0, 200), new Date().toISOString()).run();
  return json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;
  const id = Number(new URL(request.url).searchParams.get('id'));
  await env.DB.prepare('DELETE FROM blocks WHERE id = ?').bind(id).run();
  return json({ ok: true });
}
