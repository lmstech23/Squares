import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ledgerType,
  ledgerCells,
  showConfirmedSeparately,
  groupReservations,
  mergeLedger,
} from "./ledger-row.ts";

// The host ledger's derived columns. Pure — Type and the dash rules come from
// amounts the query already selects, so no join and no migration is involved.

describe("ledgerType", () => {
  test("names each kind the way a host would", () => {
    assert.equal(ledgerType({ squareAmountCents: 5000, donationAmountCents: 0 }), "Ticket purchase");
    assert.equal(ledgerType({ squareAmountCents: 0, donationAmountCents: 2500 }), "Donation");
    assert.equal(
      ledgerType({ squareAmountCents: 5000, donationAmountCents: 2500 }),
      "Tickets + donation"
    );
  });

  // Zero production rows are mixed today, so this case is untested by real
  // data and worth pinning by hand.
  test("a mixed purchase is neither of the other two", () => {
    const t = ledgerType({ squareAmountCents: 100, donationAmountCents: 1 });
    assert.equal(t, "Tickets + donation");
  });

  // Not a category. See ledgerCells - it renders as an anomaly, not a label.
  test("neither amount is null, not a name", () => {
    assert.equal(ledgerType({ squareAmountCents: 0, donationAmountCents: 0 }), null);
  });
});

describe("ledgerCells", () => {
  // THE COMPLAINT THIS ANSWERS. A donation showing 0 and $0.00 under Tickets
  // is true and reads as a ticket purchase that failed.
  test("a donation dashes the ticket columns", () => {
    const c = ledgerCells({ squareAmountCents: 0, donationAmountCents: 2500 }, 0);
    assert.equal(c.type, "Donation");
    assert.equal(c.tickets, null);
    assert.equal(c.ticketCents, null);
    assert.equal(c.donationCents, 2500);
  });

  test("a ticket purchase dashes the donation column", () => {
    const c = ledgerCells({ squareAmountCents: 5000, donationAmountCents: 0 }, 1);
    assert.equal(c.type, "Ticket purchase");
    assert.equal(c.tickets, 1);
    assert.equal(c.ticketCents, 5000);
    assert.equal(c.donationCents, null);
  });

  test("a mixed purchase dashes nothing", () => {
    const c = ledgerCells({ squareAmountCents: 5000, donationAmountCents: 2500 }, 2);
    assert.equal(c.type, "Tickets + donation");
    assert.equal(c.tickets, 2);
    assert.equal(c.ticketCents, 5000);
    assert.equal(c.donationCents, 2500);
  });

  // A REAL ZERO IS NEVER HIDDEN. Money says tickets were bought and no squares
  // are linked - the A1-era shape, and what a failed confirm-cash link leaves.
  // It has to be findable by eye.
  test("a ticket row with zero linked squares shows 0, not a dash", () => {
    const c = ledgerCells({ squareAmountCents: 2000, donationAmountCents: 0 }, 0);
    assert.equal(c.type, "Ticket purchase");
    assert.equal(c.tickets, 0, "the anomaly stays visible");
    assert.notEqual(c.tickets, null);
  });

  // Neither amount: no dash rule applies, everything renders as bare zeros so
  // the row looks as wrong as it is.
  test("a row with no money at all is shown as an anomaly, not dashed away", () => {
    const c = ledgerCells({ squareAmountCents: 0, donationAmountCents: 0 }, 0);
    assert.equal(c.tickets, 0);
    assert.equal(c.ticketCents, 0);
    assert.equal(c.donationCents, 0);
    assert.equal(c.type, "—", "typed as unrecognised rather than mislabelled");
  });
});

describe("showConfirmedSeparately", () => {
  const TZ = "America/New_York";
  const at = (iso: string) => new Date(iso);

  test("a card payment confirmed seconds later adds nothing", () => {
    assert.equal(
      showConfirmedSeparately(at("2026-09-05T18:00:00Z"), at("2026-09-05T18:00:04Z"), TZ),
      false
    );
  });

  test("a cash payment confirmed days later is worth showing", () => {
    assert.equal(
      showConfirmedSeparately(at("2026-09-01T18:00:00Z"), at("2026-09-04T14:00:00Z"), TZ),
      true
    );
  });

  // Calendar day in the BOARD's zone, not elapsed hours: an hours threshold
  // hides a payment confirmed four minutes after midnight and shows one
  // confirmed two minutes before it.
  test("either side of midnight counts as a different day", () => {
    // 2026-09-05 23:58 and 2026-09-06 00:02, Eastern.
    assert.equal(
      showConfirmedSeparately(at("2026-09-06T03:58:00Z"), at("2026-09-06T04:02:00Z"), TZ),
      true
    );
  });

  test("late evening and the small hours of the SAME day do not", () => {
    // Both 2026-09-05 Eastern, nine hours apart.
    assert.equal(
      showConfirmedSeparately(at("2026-09-05T13:00:00Z"), at("2026-09-05T22:00:00Z"), TZ),
      false
    );
  });

  test("an unconfirmed row shows nothing", () => {
    assert.equal(showConfirmedSeparately(at("2026-09-05T18:00:00Z"), null, TZ), false);
  });
});

describe("groupReservations", () => {
  const at = (iso: string) => new Date(iso);
  const sq = (
    squareId: string,
    batchId: string | null,
    cents: number,
    claimed: string | null,
    name = "Chris"
  ) => ({
    squareId,
    batchId,
    playerName: name,
    playerEmail: "c@example.com",
    pricePaidCents: cents,
    claimedAt: claimed ? at(claimed) : null,
  });

  // THE DUPLICATE-ROW PROBLEM. One reservation of three tickets is one thing
  // the contributor did, and must read as one line.
  test("a three-ticket reservation is ONE row", () => {
    const rows = groupReservations([
      sq("s1", "batch-a", 5000, "2026-09-05T18:00:00Z"),
      sq("s2", "batch-a", 5000, "2026-09-05T18:00:00Z"),
      sq("s3", "batch-a", 5000, "2026-09-05T18:00:00Z"),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tickets, 3);
    assert.equal(rows[0].ticketCents, 15000);
  });

  // Summed from what each square was reserved AT, never count x current price.
  // An early-bird reservation confirmed later still owes the early price.
  test("mixed reserved prices sum, they are not multiplied", () => {
    const rows = groupReservations([
      sq("s1", "b", 4000, "2026-09-05T18:00:00Z"),
      sq("s2", "b", 5000, "2026-09-05T18:00:00Z"),
    ]);
    assert.equal(rows[0].ticketCents, 9000, "not 2 x either price");
  });

  test("two reservations by the same person stay two rows", () => {
    const rows = groupReservations([
      sq("s1", "batch-a", 5000, "2026-09-05T18:00:00Z"),
      sq("s2", "batch-b", 5000, "2026-09-06T09:00:00Z"),
    ]);
    assert.equal(rows.length, 2, "the ledger is transaction-keyed");
  });

  // Merging on a shared null would fuse unrelated contributors into one line.
  test("null batchId falls back to one row per square", () => {
    const rows = groupReservations([
      sq("s1", null, 5000, "2026-09-05T18:00:00Z", "Alice"),
      sq("s2", null, 5000, "2026-09-05T18:05:00Z", "Bob"),
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.name).sort(), ["Alice", "Bob"]);
  });

  test("the batch carries its EARLIEST claim time", () => {
    const rows = groupReservations([
      sq("s1", "b", 100, "2026-09-05T18:30:00Z"),
      sq("s2", "b", 100, "2026-09-05T18:00:00Z"),
    ]);
    assert.equal(rows[0].at!.toISOString(), "2026-09-05T18:00:00.000Z");
  });

  test("a null price counts the ticket but adds nothing", () => {
    const rows = groupReservations([
      { squareId: "s1", batchId: "b", playerName: "X", playerEmail: null,
        pricePaidCents: null, claimedAt: at("2026-09-05T18:00:00Z") },
    ]);
    assert.equal(rows[0].tickets, 1);
    assert.equal(rows[0].ticketCents, 0);
  });
});

describe("mergeLedger", () => {
  const at = (iso: string) => new Date(iso);
  const contribution = (iso: string) => ({ createdAt: at(iso), id: iso });
  const reservation = (iso: string | null, key: string) => ({
    key, name: "R", email: null, tickets: 1, ticketCents: 100,
    at: iso ? at(iso) : null,
  });

  // ONE CHRONOLOGY. Not two lists sharing a page.
  test("both sources interleave, newest first", () => {
    const merged = mergeLedger(
      [contribution("2026-09-05T10:00:00Z"), contribution("2026-09-05T14:00:00Z")],
      [reservation("2026-09-05T12:00:00Z", "r1")]
    );
    assert.deepEqual(
      merged.map((e) => e.kind),
      ["contribution", "reservation", "contribution"],
      "the reservation sits between the two by time, not above or below them"
    );
  });

  // An old row missing a timestamp is not the oldest thing that ever happened.
  test("a reservation with no timestamp sorts last, not to 1970", () => {
    const merged = mergeLedger(
      [contribution("2026-09-05T10:00:00Z")],
      [reservation(null, "r1")]
    );
    assert.equal(merged[0].kind, "contribution");
    assert.equal(merged[1].kind, "reservation");
  });

  test("no reservations leaves the ledger exactly as it was", () => {
    const merged = mergeLedger([contribution("2026-09-05T10:00:00Z")], []);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].kind, "contribution");
  });
});
