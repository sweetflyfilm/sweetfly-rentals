import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quote, lineCents, daysBetween, unavailableItems, todayDenver } from '../pricing.js';

const catalog = JSON.parse(readFileSync(new URL('../catalog.json', import.meta.url)));
const item = (id) => catalog.groups.flatMap((g) => g.items).find((i) => i.id === id);

test('noon-to-noon: days are nights, return must be after pickup', () => {
  assert.equal(daysBetween('2026-11-02', '2026-11-02'), 0);
  assert.equal(daysBetween('2026-11-02', '2026-11-03'), 1);
  assert.equal(daysBetween('2026-11-02', '2026-11-09'), 7);
  assert.equal(daysBetween('2026-11-08', '2026-11-02'), 0);
  assert.equal(daysBetween('nope', '2026-11-02'), 0);
});

test('packages cap at the weekly price and weeks stack', () => {
  const p = item('pkg-camera'); // 265/day, 795/week
  assert.equal(lineCents(p, 1), 26500);
  assert.equal(lineCents(p, 3), 79500);
  assert.equal(lineCents(p, 5), 79500); // capped at the week
  assert.equal(lineCents(p, 7), 79500);
  assert.equal(lineCents(p, 8), 79500 + 26500);
  assert.equal(lineCents(p, 14), 159000);
});

test('week items bill per started 7 days', () => {
  assert.equal(lineCents(item('jug'), 1), 500);
  assert.equal(lineCents(item('jug'), 8), 1000);
});

test('no insurance adds a 12% waiver and a doubled deposit', () => {
  const q = quote(catalog, { items: { tables: 1, chairs: 1 }, start: '2026-11-02', end: '2026-11-03', hasCoi: false });
  assert.ok(q.ok);
  assert.equal(q.subtotal, 4000);
  assert.equal(q.waiver, 480);            // 12%
  assert.equal(q.tax, 0); // no sales tax is charged
  assert.equal(q.deposit, 8000);          // ($20 + $20) x 2
});

test('insurance on file: no waiver, no deposit, charged at pickup', () => {
  const q = quote(catalog, { items: { generator: 1 }, start: '2026-11-02', end: '2026-11-04', hasCoi: true });
  assert.equal(q.subtotal, 10000);
  assert.equal(q.waiver, 0);
  assert.equal(q.tax, 0);
  assert.equal(q.deposit, 0);
  assert.equal(q.dueNow, 10000);
  assert.equal(q.deferred, true);
  const none = quote(catalog, { items: { generator: 1 }, start: '2026-11-02', end: '2026-11-04', hasCoi: false });
  assert.equal(none.deferred, false);
  assert.equal(none.deposit, 30000); // no insurance keeps the doubled deposit
});

test('high value gear refuses to price without insurance', () => {
  const q = quote(catalog, { items: { 'pkg-camera': 1 }, start: '2026-11-02', end: '2026-11-03', hasCoi: false });
  assert.equal(q.ok, false);
  assert.ok(q.errors.some((e) => e.code === 'coi_required'));
  const ok = quote(catalog, { items: { 'pkg-camera': 1 }, start: '2026-11-02', end: '2026-11-03', hasCoi: true });
  assert.ok(ok.ok);
});

test('rejects past dates, long rentals, unknown items, empty carts', () => {
  const base = { start: '2026-11-02', end: '2026-11-03', hasCoi: true };
  assert.ok(quote(catalog, { ...base, items: { jug: 1 }, today: '2026-11-03' }).errors.some((e) => e.code === 'past'));
  assert.ok(quote(catalog, { ...base, end: '2026-12-31', items: { jug: 1 } }).errors.some((e) => e.code === 'too_long'));
  assert.ok(quote(catalog, { ...base, items: { bogus: 1 } }).errors.some((e) => e.code === 'unknown_item'));
  assert.ok(quote(catalog, { ...base, items: {} }).errors.some((e) => e.code === 'no_items'));
});

test('availability checks every day and counts package components', () => {
  // Booked: pickup Nov 4 noon+, back Nov 6 before noon -> holds the nights of Nov 4 and 5.
  const booked = [{ start_date: '2026-11-04', end_date: '2026-11-06', items: { 'set-ready': 1 } }];
  // generator is in the booked package (stock 1)
  assert.deepEqual(unavailableItems(catalog, { generator: 1 }, '2026-11-03', '2026-11-05', booked), ['generator']);
  assert.deepEqual(unavailableItems(catalog, { generator: 1 }, '2026-11-07', '2026-11-08', booked), []);
  // same-day turnaround: they return before noon Nov 6, we pick up after noon Nov 6
  assert.deepEqual(unavailableItems(catalog, { generator: 1 }, '2026-11-06', '2026-11-07', booked), []);
  // and we can return Nov 4 before noon, before their pickup after noon
  assert.deepEqual(unavailableItems(catalog, { generator: 1 }, '2026-11-03', '2026-11-04', booked), []);
  // Basecamp uses both actual tables and the entire set of eight chairs.
  assert.deepEqual(unavailableItems(catalog, { tables: 1 }, '2026-11-04', '2026-11-06', booked), ['tables']);
  assert.deepEqual(unavailableItems(catalog, { chairs: 1 }, '2026-11-04', '2026-11-06', booked), ['chairs']);
  // Two of the three tents are in the package, leaving one available by request.
  assert.deepEqual(unavailableItems(catalog, { canopy: 1 }, '2026-11-04', '2026-11-06', booked), []);
  assert.deepEqual(unavailableItems(catalog, { canopy: 2 }, '2026-11-04', '2026-11-06', booked), ['canopy']);
  // Full packages no longer include the generator, so a booked Basecamp doesn't block them
  assert.deepEqual(unavailableItems(catalog, { 'pkg-full-pro': 1 }, '2026-11-05', '2026-11-06', booked), []);
  // but Full Go and Full Pro share the dolly, lenses and grip, so a booked Go blocks Pro
  const bookedFull = [{ start_date: '2026-11-04', end_date: '2026-11-06', items: { 'pkg-full-go': 1 } }];
  assert.deepEqual(unavailableItems(catalog, { 'pkg-full-pro': 1 }, '2026-11-05', '2026-11-06', bookedFull), ['pkg-full-pro']);
});

test('todayDenver returns an ISO date', () => {
  assert.match(todayDenver(), /^\d{4}-\d{2}-\d{2}$/);
});

test('catalog integrity: unique ids, every used resource has stock, prices set', () => {
  const all = catalog.groups.flatMap((g) => g.items);
  const ids = all.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate item id');
  for (const it of all) {
    assert.ok(it.rate > 0 && it.deposit > 0, `${it.id} needs rate and deposit`);
    assert.ok(Object.keys(it.uses || {}).length, `${it.id} uses nothing`);
    for (const [res, n] of Object.entries(it.uses)) {
      assert.ok(catalog.stock[res] >= n, `${it.id} needs ${n} ${res} but stock is ${catalog.stock[res]}`);
    }
    if (it.week) assert.ok(it.week <= it.rate * 7, `${it.id} week price above 7 days`);
  }
  for (const res of Object.keys(catalog.stock)) assert.ok(all.some((i) => i.uses[res]), `stock ${res} is not used by any item`);
});

test('every item can be priced alone with insurance or waiver', () => {
  for (const it of catalog.groups.flatMap((g) => g.items)) {
    const q = quote(catalog, { items: { [it.id]: 1 }, start: '2026-11-02', end: '2026-11-03', hasCoi: true });
    assert.ok(q.ok, it.id);
    const n = quote(catalog, { items: { [it.id]: 1 }, start: '2026-11-02', end: '2026-11-03', hasCoi: false });
    assert.equal(n.ok, !it.highValue, it.id);
  }
});

test('a tax rate in catalog.json still works if one is ever set', () => {
  const q = quote({ ...catalog, taxRate: 0.0825 }, { items: { generator: 1 }, start: '2026-11-02', end: '2026-11-04', hasCoi: true });
  assert.equal(q.tax, 825);
  assert.equal(q.dueNow, 10000 + 825); // insured: no deposit
});
