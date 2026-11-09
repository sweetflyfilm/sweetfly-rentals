// Shared by the checkout page and the Pages Functions, so the number a renter
// sees is the number the server charges. Money is integer cents everywhere.

const DAY = 864e5;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const toMs = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
export const isIsoDate = (s) => typeof s === 'string' && ISO.test(s) && !Number.isNaN(toMs(s));

// Pickup after 12 PM, return before 12 PM: a rental day is noon to noon, so days = nights.
// Monday pickup, Tuesday return = 1 day. Return must be after pickup.
export function daysBetween(start, end) {
  if (!isIsoDate(start) || !isIsoDate(end)) return 0;
  const d = Math.round((toMs(end) - toMs(start)) / DAY);
  return d > 0 ? d : 0;
}

export function eachDay(start, end) {
  const out = [];
  for (let t = toMs(start); t <= toMs(end); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// Today's date in the shop's timezone (Denver) as YYYY-MM-DD.
export function todayDenver(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(now);
}

const lastNight = (end) => new Date(toMs(end) - DAY).toISOString().slice(0, 10);

export const indexItems = (catalog) => {
  const byId = {};
  catalog.groups.forEach((g) => g.items.forEach((it) => { byId[it.id] = it; }));
  return byId;
};

// Day items with a `week` price cap each started week; 'week' items bill per started 7 days.
export function lineCents(item, days) {
  const rate = Math.round(item.rate * 100);
  if (item.unit === 'week') return rate * Math.max(1, Math.ceil(days / 7));
  if (item.week) {
    const wk = Math.round(item.week * 100);
    return Math.floor(days / 7) * wk + Math.min((days % 7) * rate, wk);
  }
  return rate * days;
}

export function quote(catalog, { items, start, end, hasCoi, today }) {
  const byId = indexItems(catalog);
  const errors = [];
  const days = daysBetween(start, end);
  if (!days) errors.push({ code: 'dates', message: 'Pick a pickup date and a return date after it.' });
  else if (today && start < today) errors.push({ code: 'past', message: 'Pickup can’t be in the past.' });
  else if (days > catalog.maxDays) errors.push({ code: 'too_long', message: `Rentals longer than ${catalog.maxDays} days: email us.` });

  const lines = [];
  let subtotal = 0, deposit = 0, highValue = false;
  for (const [id, raw] of Object.entries(items || {})) {
    const qty = Math.floor(Number(raw));
    if (!qty) continue;
    const it = byId[id];
    if (!it || qty < 0 || qty > 20) { errors.push({ code: 'unknown_item', message: `Unknown item ${id}.` }); continue; }
    const cents = days ? lineCents(it, days) * qty : 0;
    subtotal += cents;
    deposit += Math.round(it.deposit * 100) * qty;
    if (it.highValue) highValue = true;
    lines.push({ id, name: it.name, qty, cents });
  }
  if (!lines.length) errors.push({ code: 'no_items', message: 'Add at least one item.' });
  if (highValue && !hasCoi) errors.push({ code: 'coi_required', message: 'Camera, lighting and full packages need a certificate of insurance.' });

  // No certificate: damage waiver fee plus a bigger deposit, both charged when Grant approves.
  // Insurance on file: no waiver and no deposit. The card is held at request and the full rental is
  // charged the day before pickup (see `deferred`).
  const waiver = hasCoi ? 0 : Math.round(subtotal * catalog.waiverRate);
  deposit = hasCoi ? 0 : Math.round(deposit * catalog.noInsuranceDepositMultiplier);
  const tax = Math.round((subtotal + waiver) * catalog.taxRate);
  return {
    ok: !errors.length, errors, days, lines, highValue,
    subtotal, waiver, tax, deposit,
    deferred: !!hasCoi,
    rentalTotal: subtotal + waiver + tax,
    dueNow: subtotal + waiver + tax + deposit
  };
}

// Everything an order takes out of stock, e.g. { generator: 1, canopy: 1 }.
export function usage(catalog, items) {
  const byId = indexItems(catalog), out = {};
  for (const [id, qty] of Object.entries(items || {})) {
    const it = byId[id];
    if (!it || !qty) continue;
    for (const [res, n] of Object.entries(it.uses || {})) out[res] = (out[res] || 0) + n * qty;
  }
  return out;
}

// `bookings` = [{ start_date, end_date, items: {id: qty} }] that hold stock. Checks every night.
// A booking holds the gear from its pickup day up to (not including) its return day, because the
// return is before noon and the next pickup is after noon.
// Returns the ids of requested items that can't be had for the whole range.
export function unavailableItems(catalog, wanted, start, end, bookings) {
  const need = usage(catalog, wanted);
  const short = new Set();
  for (const day of eachDay(start, lastNight(end))) {
    const used = {};
    for (const b of bookings) {
      if (b.start_date > day || b.end_date <= day) continue;
      for (const [res, n] of Object.entries(usage(catalog, b.items))) used[res] = (used[res] || 0) + n;
    }
    for (const [res, n] of Object.entries(need)) {
      if ((used[res] || 0) + n > (catalog.stock[res] ?? 0)) short.add(res);
    }
  }
  const byId = indexItems(catalog);
  return Object.entries(wanted || {})
    .filter(([id, qty]) => qty && Object.keys(byId[id]?.uses || {}).some((r) => short.has(r)))
    .map(([id]) => id);
}
