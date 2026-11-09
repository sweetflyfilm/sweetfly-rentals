import { json, fail, randomId, siteUrl } from '../_lib/http.js';
import { createHoldSession } from '../_lib/session.js';
import { unavailableFor } from '../_lib/bookings.js';
import { catalog } from '../_lib/catalog.js';
import { quote, todayDenver } from '../../pricing.js';

const MAX_COI_BYTES = 8 * 1024 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// First bytes decide the real type; the browser-supplied one is not trusted.
async function sniff(file) {
  const b = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return { ext: 'pdf', type: 'application/pdf' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', type: 'image/png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  return null;
}

async function turnstileOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token || '', remoteip: ip || '' });
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  return !!(await res.json()).success;
}

// POST multipart: `payload` (JSON) + optional `coi` file. Prices are recomputed here; nothing the
// browser says about money is trusted. The card is authorized, not charged, until Grant approves.
export async function onRequestPost({ request, env }) {
  let form;
  try { form = await request.formData(); } catch { return fail(400, 'bad_request', 'Could not read the form.'); }
  let p;
  try { p = JSON.parse(form.get('payload') || '{}'); } catch { return fail(400, 'bad_request', 'Could not read the form.'); }

  const name = String(p.name || '').trim().slice(0, 100);
  const email = String(p.email || '').trim().slice(0, 200);
  const phone = String(p.phone || '').trim().slice(0, 30);
  const notes = String(p.notes || '').trim().slice(0, 1000);
  if (!name) return fail(400, 'name', 'Add your name.');
  if (!EMAIL.test(email)) return fail(400, 'email', 'Add a valid email.');
  if (p.terms !== true) return fail(400, 'terms', 'Please accept the rental terms.');
  if (!(await turnstileOk(env, p.turnstile, request.headers.get('cf-connecting-ip')))) return fail(400, 'captcha', 'Please complete the check and try again.');

  const file = form.get('coi');
  const hasFile = file && typeof file !== 'string' && file.size > 0;
  let kind = null;
  if (hasFile) {
    if (file.size > MAX_COI_BYTES) return fail(400, 'coi_size', 'That file is over 8 MB. Upload a PDF, JPG or PNG under 8 MB.');
    kind = await sniff(file);
    if (!kind) return fail(400, 'coi_type', 'Insurance must be a PDF, JPG or PNG.');
  } else if (p.insurance === 'have') {
    return fail(400, 'coi_missing', 'Upload your certificate of insurance, or choose “I don’t have insurance”.');
  }

  const q = quote(catalog, { items: p.items, start: p.start, end: p.end, hasCoi: !!kind, today: todayDenver() });
  if (!q.ok) return fail(400, q.errors[0].code, q.errors[0].message);

  const items = Object.fromEntries(q.lines.map((l) => [l.id, l.qty]));
  const id = randomId(6), token = randomId(16);
  const now = new Date();
  const holdSec = Math.max(31, catalog.holdMinutes) * 60;
  const expiresAt = new Date(now.getTime() + holdSec * 1000).toISOString();

  // Only approved bookings and Grant's manual blocks hold stock, so a request never blocks anyone;
  // Grant approves each one and is warned about overlaps. This check just stops requests for gear
  // that is already confirmed out.
  const unavailable = await unavailableFor(env.DB, items, p.start, p.end);
  if (unavailable.length) {
    return json({ error: 'unavailable', message: 'Some items are booked for those dates.', unavailable }, 409);
  }

  await env.DB.prepare(
    `INSERT INTO bookings (id, token, status, name, email, phone, notes, start_date, end_date, days, items_json,
       subtotal_cents, waiver_cents, tax_cents, deposit_cents, total_cents, has_coi, terms_accepted_at, created_at, expires_at)
     VALUES (?1,?2,'pending',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?17,?18)`
  ).bind(id, token, name, email, phone, notes, p.start, p.end, q.days, JSON.stringify(items),
    q.subtotal, q.waiver, q.tax, q.deposit, q.dueNow, kind ? 1 : 0, now.toISOString(), expiresAt).run();

  const cancel = () => env.DB.prepare('DELETE FROM bookings WHERE id = ?').bind(id).run();

  let key = null;
  try {
    if (kind) {
      key = `coi/${id}/${randomId(8)}.${kind.ext}`;
      await env.DOCS.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: kind.type },
        customMetadata: { booking: id, original: String(file.name || '').slice(0, 120) }
      });
      await env.DB.prepare('UPDATE bookings SET coi_key = ?2, coi_name = ?3 WHERE id = ?1')
        .bind(id, key, String(file.name || 'insurance').slice(0, 120)).run();
    }

    const site = siteUrl(request, env);
    const session = await createHoldSession(env, { id, token, email, site, q, start: p.start, end: p.end, holdSec });
    await env.DB.prepare('UPDATE bookings SET stripe_session_id = ?2 WHERE id = ?1').bind(id, session.id).run();
    return json({ url: session.url, id });
  } catch (err) {
    console.error('checkout failed', id, err.message);
    await cancel();
    if (key) await env.DOCS.delete(key).catch(() => {});
    return fail(502, 'checkout_failed', 'We couldn’t start the payment. Please try again in a minute.');
  }
}
