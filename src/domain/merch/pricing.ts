// Merch pricing — spec §4. Integer cents only.
//
// fee() reproduces Stripe's fee for a US card charge EXACTLY as measured on
// Oct 16, 2026 in test mode (spec §4.1): 2.9% + 30¢, rounded to the nearest
// cent with halves rounded UP ($25.00 → $1.03, $35.00 → $1.32, $41.50 → $1.50).
//
// priceForNet() returns the SMALLEST unit price whose per-order net meets the
// organizer's net for every quantity she allows. It never rounds a gross-up
// formula upward and stops there — that was Revision 2's defect.

export const PROCESSING_ASSUMPTIONS = {
  percentBasisPoints: 290, // 2.9%
  fixedCents: 30,
  rounding: "half-up" as const,
  version: "us-card-2026-10",
};

/** Stripe's fee on a charge of `totalCents`, measured rounding (half up). */
export function fee(totalCents: number): number {
  assertCents(totalCents);
  if (totalCents === 0) return 0;
  // 2.9% = 29/1000. fee = floor((29·t + 30·1000 + 500) / 1000)
  return Math.floor((29 * totalCents + PROCESSING_ASSUMPTIONS.fixedCents * 1000 + 500) / 1000);
}

/** What the organizer receives from a charge of `totalCents`. */
export function netOf(totalCents: number): number {
  return totalCents - fee(totalCents);
}

/**
 * Smallest unit price p such that for every q in 1..maxQuantity,
 * q·p − fee(q·p) ≥ q·net.
 */
export function priceForNet(netCents: number, maxQuantity = 1): number {
  assertCents(netCents);
  if (netCents <= 0) throw new Error("netCents must be positive");
  if (!Number.isInteger(maxQuantity) || maxQuantity < 1 || maxQuantity > 1000) {
    throw new Error("maxQuantity must be an integer from 1 to 1000");
  }
  // Lower bound: with no fixed fee and no rounding, p ≥ net / 0.971. Start a
  // little below it and walk up one cent at a time; the answer is always within
  // a few cents of the bound, so this is a handful of iterations.
  let p = Math.max(1, Math.floor(netCents / 0.971) - 2);
  for (;;) {
    if (meetsForAllQuantities(p, netCents, maxQuantity)) return p;
    p += 1;
  }
}

function meetsForAllQuantities(p: number, net: number, maxQuantity: number): boolean {
  for (let q = 1; q <= maxQuantity; q++) {
    if (netOf(q * p) < q * net) return false;
  }
  return true;
}

/** Order totals from lines already priced. */
export function orderTotals(lines: { quantity: number; unitPriceCents: number; unitNetCents: number }[]) {
  let totalCents = 0;
  let netTargetCents = 0;
  for (const l of lines) {
    totalCents += l.quantity * l.unitPriceCents;
    netTargetCents += l.quantity * l.unitNetCents;
  }
  return { totalCents, netTargetCents, estimatedFeeCents: fee(totalCents), estimatedNetCents: netOf(totalCents) };
}

function assertCents(n: number) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`expected non-negative integer cents, got ${n}`);
}

export function formatCents(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}
