import { test } from "node:test";
import assert from "node:assert/strict";
import { fee, netOf, priceForNet, orderTotals } from "./pricing.ts";

// The six charges measured in Stripe test mode on Oct 16, 2026 (spec §4.1).
const MEASURED: [number, number][] = [
  [4150, 150],
  [4149, 150],
  [8300, 271],
  [12450, 391],
  [2500, 103], // exact 102.5 → half up
  [3500, 132], // exact 131.5 → half up
];

test("fee() reproduces every measured Stripe fee exactly", () => {
  for (const [total, expected] of MEASURED) assert.equal(fee(total), expected, `fee(${total})`);
});

test("$40.00 net → $41.50, and $41.49 falls short", () => {
  assert.equal(priceForNet(4000, 1), 4150);
  assert.equal(netOf(4150), 4000);
  assert.ok(netOf(4149) < 4000);
  assert.equal(priceForNet(4000, 10), 4150);
});

test("priceForNet is minimal and sufficient for every net $1–$1,000, quantities up to 10", () => {
  for (let net = 100; net <= 100000; net += 1) {
    const p = priceForNet(net, 10);
    for (let q = 1; q <= 10; q++) assert.ok(netOf(q * p) >= q * net, `net ${net} q ${q} p ${p}`);
    // Minimal: one cent less fails for at least one allowed quantity.
    let fails = false;
    for (let q = 1; q <= 10 && !fails; q++) if (netOf(q * (p - 1)) < q * net) fails = true;
    assert.ok(fails, `price ${p} for net ${net} is not minimal`);
  }
});

test("multi-shirt orders at $41.50 meet the organizer's net", () => {
  const t = orderTotals([{ quantity: 3, unitPriceCents: 4150, unitNetCents: 4000 }]);
  assert.equal(t.totalCents, 12450);
  assert.equal(t.estimatedFeeCents, 391);
  assert.equal(t.estimatedNetCents, 12059);
  assert.ok(t.estimatedNetCents >= t.netTargetCents);
});

test("rejects non-integer and negative cents", () => {
  assert.throws(() => fee(10.5));
  assert.throws(() => priceForNet(-1));
  assert.throws(() => priceForNet(4000, 0));
});
