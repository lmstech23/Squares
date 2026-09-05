// What to render when a donor comes back from a donation-only card checkout.
//
// The session id in the URL is a LOOKUP KEY, NEVER A CLAIM. It selects the
// ledger row; the row's own status decides what the page says. That is the same
// rule the ticket return follows — it finds squares by `checkoutSessionId`
// rather than trusting anything in the query string — and it is what stops a
// fabricated, replayed, or copied `?donated=true&session_id=…` from rendering a
// confirmation for money that was never taken.
//
// Separated from the page so the guards can be tested against real rows. The
// query stays in the page; only the decision lives here.

export interface DonationLedgerRow {
  boardId: string;
  status: string;
  squareAmountCents: number;
  /**
   * A void does NOT change `status` — donations §7 makes it write-once and
   * leaves the row reading `confirmed` so it stays visible as what it was.
   * Testing `status` alone would show "Payment received" over money the host
   * has already reversed. The schema comment warns about exactly this:
   * "forgetting the second silently resurrects voided money into totals."
   */
  voidedAt: Date | null;
}

export interface DonationReturn {
  /** The row reads `confirmed`. False means the webhook has not landed yet. */
  settled: boolean;
}

/**
 * `null` means render nothing at all — not an error, not a neutral banner.
 *
 * Four ways to get null, each a case where a confirmation would be a lie:
 *
 *  - no row: the session id matches nothing
 *  - another board's row: someone pasted a link from a different campaign
 *  - squares attached: a MIXED checkout, which returns through `?success=true`
 *    and renders the ticket confirmation; showing a donation receipt would
 *    silently drop the tickets from what the contributor is told they bought
 *  - `released`, or `confirmed` carrying a `voidedAt`: the payment did not stand
 */
export function donationReturnState(
  row: DonationLedgerRow | null,
  boardId: string
): DonationReturn | null {
  if (!row) return null;
  if (row.boardId !== boardId) return null;
  if (row.squareAmountCents !== 0) return null;
  if (row.voidedAt !== null) return null;
  if (row.status !== "confirmed" && row.status !== "pending") return null;
  return { settled: row.status === "confirmed" };
}
