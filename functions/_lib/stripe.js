// Minimal Stripe REST client (no SDK): form-encoded requests, WebCrypto webhook check.
import { timingSafeEqual } from './http.js';

// {a: {b: [1,2]}} -> a[b][0]=1&a[b][1]=2
function encode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}

export async function stripe(env, method, path, params, idempotencyKey) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  const headers = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  let url = `${env.STRIPE_API_BASE || 'https://api.stripe.com/v1'}/${path}`;
  const init = { method, headers };
  const body = params ? encode(params).join('&') : '';
  if (method === 'GET') { if (body) url += `?${body}`; }
  else { headers['content-type'] = 'application/x-www-form-urlencoded'; init.body = body; }
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${data?.error?.message || 'request failed'}`);
  return data;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// Stripe-Signature: t=<unix>,v1=<hmac sha256 of "t.body">[,v1=...]
export async function verifyWebhook(rawBody, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`)));
  return sigs.some((s) => timingSafeEqual(s, expected));
}
