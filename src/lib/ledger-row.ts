// How one Contribution reads in the host ledger.
//
// ONE ROW PER CONTRIBUTION. The ledger is transaction-keyed and stays that way:
// never merged by person, never rolled up. The contributor list on the board
// page is the per-person view; this is the per-payment one, and a host settling
// a dispute needs the payment.
//
// Everything here is DERIVED FROM COLUMNS THE QUERY ALREADY SELECTS. No join,
// no new field, no migration.

export type LedgerType = "Ticket purchase" | "Donation" | "Tickets + donation";

export interface LedgerAmounts {
  squareAmountCents: number;
  donationAmountCents: number;
}

/**
 * What kind of payment this row is, in the words a host would use.
 *
 * Returns null for a row with NEITHER amount. That should not exist, and
 * naming it would make it look like a category rather than a defect — see
 * `ledgerCells`, which deliberately renders such a row as bare zeros so it
 * stays visibly wrong.
 */
export function ledgerType(a: LedgerAmounts): LedgerType | null {
  const tickets = a.squareAmountCents > 0;
  const donation = a.donationAmountCents > 0;
  if (tickets && donation) return "Tickets + donation";
  if (tickets) return "Ticket purchase";
  if (donation) return "Donation";
  return null;
}

export interface LedgerCells {
  type: string;
  /** `null` renders as an em dash: the field does not apply to this row. */
  tickets: number | null;
  ticketCents: number | null;
  donationCents: number | null;
}

/**
 * Which cells apply, and which are genuinely not applicable.
 *
 * THE DASH MEANS "NOT APPLICABLE", NEVER "ZERO". A donation showing `0` and
 * `$0.00` under Tickets is technically true and reads as a ticket purchase that
 * failed; a host scanning the column for problems finds one that is not there.
 *
 * A REAL ZERO IS NEVER HIDDEN. Two cases matter, and both stay as digits:
 *
 *  - a row typed `Ticket purchase` whose ticket COUNT is 0. Its money says
 *    tickets were bought; no squares are linked. That is the A1-era shape and
 *    the shape a failed confirm-cash link would leave, and it must be
 *    findable by eye.
 *  - a row with neither amount. `ledgerType` returns null, so no dash rule
 *    applies and every column renders bare zeros.
 */
export function ledgerCells(a: LedgerAmounts, squareCount: number): LedgerCells {
  const type = ledgerType(a);

  if (type === null) {
    // An anomaly, shown as one. Nothing is dashed away.
    return {
      type: "—",
      tickets: squareCount,
      ticketCents: a.squareAmountCents,
      donationCents: a.donationAmountCents,
    };
  }

  return {
    type,
    tickets: type === "Donation" ? null : squareCount,
    ticketCents: type === "Donation" ? null : a.squareAmountCents,
    donationCents: type === "Ticket purchase" ? null : a.donationAmountCents,
  };
}

/**
 * Should the confirmation date be shown beside the created date?
 *
 * ONLY WHEN IT ADDS SOMETHING. A card purchase confirms seconds after it is
 * created and repeating the date is noise; a cash contribution confirmed three
 * days later is the fact a host is looking for. Different calendar day in the
 * board's zone is the test — not an elapsed-hours threshold, which would show a
 * second date for a payment confirmed at 11:58pm and hide one confirmed at
 * 12:02am the next morning.
 */
export function showConfirmedSeparately(
  createdAt: Date,
  confirmedAt: Date | null,
  timeZone: string
): boolean {
  if (!confirmedAt) return false;
  const day = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  return day(createdAt) !== day(confirmedAt);
}

// ---------------------------------------------------------------------------
// Reserved cash tickets in the ledger
// ---------------------------------------------------------------------------
//
// A `reserved_cash` square creates NO Contribution — the ledger row appears
// only when the host marks the money received. So a contributor who has
// committed to paying is invisible in a table that claims to show every state.
//
// NO SYNTHETIC Contribution IS CREATED. These are read from `Square` and
// rendered alongside, clearly marked, and they touch no money state: every
// figure above the table comes from `boardTotals`, which reads Contribution
// only and cannot see them.

export interface ReservedSquare {
  squareId: string;
  batchId: string | null;
  playerName: string | null;
  playerEmail: string | null;
  pricePaidCents: number | null;
  claimedAt: Date | null;
}

export interface ReservationRow {
  key: string;
  name: string;
  email: string | null;
  tickets: number;
  ticketCents: number;
  at: Date | null;
}

/**
 * One row per RESERVATION, not per square.
 *
 * `cash-reserve` assigns one `batchId` across every square in a reservation, so
 * a three-ticket reservation is one event and reads as one line. Grouping per
 * square instead would print three visually identical rows for one thing the
 * contributor did once — the same complaint that started this work.
 *
 * A NULL batchId FALLS BACK TO ONE ROW PER SQUARE. That is written only on
 * Game Day squares today, which never reach this page, but merging rows on a
 * shared null would fuse unrelated contributors into one line. Better a
 * redundant row than a wrong one.
 *
 * GROUPED HERE, NEVER IN THE WORKLIST. This is history: the reservation
 * happened once. Confirming is per square — invariant 7 requires that someone
 * who reserves 3 and sends $100 resolves to 2 confirmed and 1 released — and
 * that surface stays per square.
 */
export function groupReservations(squares: ReservedSquare[]): ReservationRow[] {
  const byKey = new Map<string, ReservationRow>();
  for (const sq of squares) {
    const key = sq.batchId ?? `square:${sq.squareId}`;
    const existing = byKey.get(key);
    const cents = sq.pricePaidCents ?? 0;
    if (!existing) {
      byKey.set(key, {
        key,
        name: sq.playerName ?? "—",
        email: sq.playerEmail,
        tickets: 1,
        ticketCents: cents,
        at: sq.claimedAt,
      });
      continue;
    }
    existing.tickets++;
    // The price each square was reserved AT, summed — never count times the
    // board's current price (invariant 48).
    existing.ticketCents += cents;
    // Earliest claim in the batch: when the reservation was made.
    if (sq.claimedAt && (!existing.at || sq.claimedAt < existing.at)) {
      existing.at = sq.claimedAt;
    }
  }
  return [...byKey.values()];
}

export type LedgerEntry<C> =
  | { kind: "contribution"; at: Date; row: C }
  | { kind: "reservation"; at: Date | null; row: ReservationRow };

/**
 * One chronology, newest first.
 *
 * INTERLEAVED, NOT SEGREGATED. A ledger that puts reservations in their own
 * block stops being a history of the board and becomes two lists that happen
 * to share a page.
 *
 * A reservation with no `claimedAt` sorts LAST rather than to 1970: it is an
 * old row missing a timestamp, not the oldest thing that ever happened.
 */
export function mergeLedger<C extends { createdAt: Date }>(
  contributions: C[],
  reservations: ReservationRow[]
): LedgerEntry<C>[] {
  const entries: LedgerEntry<C>[] = [
    ...contributions.map((row) => ({ kind: "contribution" as const, at: row.createdAt, row })),
    ...reservations.map((row) => ({ kind: "reservation" as const, at: row.at, row })),
  ];
  return entries.sort((a, b) => {
    if (a.at === null && b.at === null) return 0;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return b.at.getTime() - a.at.getTime();
  });
}
