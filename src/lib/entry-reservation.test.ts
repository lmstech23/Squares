import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  expandReservationLines,
  reservationTotalCents,
  type ReservationLine,
} from "./entry-reservation.ts";

// THE EXPANSION SEAM.
//
// A reservation stores grouped tier lines because a host confirms "two adults
// arrived". confirmEntryPurchase needs one entry per pass because every
// AdmissionPass carries its own price, and it ASSERTS that those prices sum to
// the contribution amount.
//
// Both failure modes here are silent, which is why this is tested on its own
// rather than only through the confirmation:
//
//   wrong COUNT  the sum assertion fires on a purchase that was correct
//   wrong PRICE  re-quoting at today's rate passes the assertion only when the
//                contribution amount was computed the same wrong way, so the
//                two agree with each other and disagree with what was reserved
//
// The pairing with reservationTotalCents is the invariant: expand and sum must
// equal total, always, or the confirmation cannot succeed.

const HAMPTON: ReservationLine[] = [
  { tier: "ADULT", priceBasis: "EARLY", unitPriceCents: 4000, quantity: 2 },
  { tier: "CHILD", priceBasis: "FLAT", unitPriceCents: 1500, quantity: 1 },
];

describe("expandReservationLines", () => {
  test("one pass per unit of quantity, not one per line", () => {
    const passes = expandReservationLines(HAMPTON);
    assert.equal(passes.length, 3);
    assert.equal(passes.filter((p) => p.tier === "ADULT").length, 2);
    assert.equal(passes.filter((p) => p.tier === "CHILD").length, 1);
  });

  test("every pass carries the STORED unit price, never a re-quote", () => {
    for (const p of expandReservationLines(HAMPTON)) {
      assert.equal(p.pricePaidCents, p.tier === "ADULT" ? 4000 : 1500);
    }
  });

  test("the price basis survives expansion", () => {
    const passes = expandReservationLines(HAMPTON);
    assert.equal(passes.find((p) => p.tier === "ADULT")!.priceBasis, "EARLY");
    assert.equal(passes.find((p) => p.tier === "CHILD")!.priceBasis, "FLAT");
  });

  // THE ASSERTION THE CONFIRMATION DEPENDS ON. If this ever fails,
  // confirmEntryPurchase throws EntryAmountMismatch on a correct reservation.
  test("expanded passes always sum to the reservation total", () => {
    const cases: ReservationLine[][] = [
      HAMPTON,
      [{ tier: "CHILD", priceBasis: "FLAT", unitPriceCents: 1500, quantity: 1 }],
      [{ tier: "ADULT", priceBasis: "REGULAR", unitPriceCents: 5000, quantity: 12 }],
      [
        { tier: "ADULT", priceBasis: "REGULAR", unitPriceCents: 5000, quantity: 3 },
        { tier: "CHILD", priceBasis: "FLAT", unitPriceCents: 1500, quantity: 4 },
      ],
      // A price with cents, so a rounding error would show.
      [{ tier: "ADULT", priceBasis: "EARLY", unitPriceCents: 3333, quantity: 7 }],
    ];
    for (const lines of cases) {
      const sum = expandReservationLines(lines).reduce(
        (n, p) => n + p.pricePaidCents,
        0
      );
      assert.equal(sum, reservationTotalCents(lines), JSON.stringify(lines));
    }
  });

  // An ADULT tier can appear at two bases only across different reservations,
  // never within one - the unique index forbids it - but expansion must not
  // care, and must not merge them if it ever sees them.
  test("two lines of the same tier at different bases stay distinct", () => {
    const passes = expandReservationLines([
      { tier: "ADULT", priceBasis: "EARLY", unitPriceCents: 4000, quantity: 1 },
      { tier: "ADULT", priceBasis: "REGULAR", unitPriceCents: 5000, quantity: 1 },
    ]);
    assert.equal(passes.length, 2);
    assert.equal(passes.filter((p) => p.priceBasis === "EARLY")[0].pricePaidCents, 4000);
    assert.equal(passes.filter((p) => p.priceBasis === "REGULAR")[0].pricePaidCents, 5000);
  });

  test("a large quantity expands exactly, with no off-by-one", () => {
    const passes = expandReservationLines([
      { tier: "ADULT", priceBasis: "REGULAR", unitPriceCents: 5000, quantity: 40 },
    ]);
    assert.equal(passes.length, 40);
    assert.equal(
      passes.reduce((n, p) => n + p.pricePaidCents, 0),
      200_000
    );
  });

  test("no lines expands to no passes", () => {
    assert.deepEqual(expandReservationLines([]), []);
    assert.equal(reservationTotalCents([]), 0);
  });
});

describe("reservationTotalCents", () => {
  test("multiplies each line and sums, from stored prices only", () => {
    assert.equal(reservationTotalCents(HAMPTON), 2 * 4000 + 1500);
  });

  test("a single line is its own total", () => {
    assert.equal(
      reservationTotalCents([
        { tier: "CHILD", priceBasis: "FLAT", unitPriceCents: 1500, quantity: 3 },
      ]),
      4500
    );
  });
});
