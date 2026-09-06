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
