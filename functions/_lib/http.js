export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
  });

export const fail = (status, error, message) => json({ error, message: message || error }, status);

export function randomId(bytes = 6) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function requireAdmin(request, env) {
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN || !given || !timingSafeEqual(given, env.ADMIN_TOKEN)) return fail(401, 'unauthorized');
  return null;
}

export const siteUrl = (request, env) => (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
