import { fail, requireAdmin } from '../../_lib/http.js';

// GET /api/admin/coi?id=... - streams the renter's insurance certificate from the private bucket.
export async function onRequestGet({ request, env }) {
  const denied = requireAdmin(request, env);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get('id') || '';
  const row = await env.DB.prepare('SELECT coi_key, coi_name FROM bookings WHERE id = ?').bind(id).first();
  if (!row?.coi_key) return fail(404, 'no_certificate');
  const obj = await env.DOCS.get(row.coi_key);
  if (!obj) return fail(404, 'no_certificate');
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'content-disposition': `inline; filename="${(row.coi_name || 'insurance').replace(/[^\w.\- ]/g, '_')}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}
