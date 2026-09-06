// One row per contributor for the host board page — v2 §9.
//
// TWO SOURCES, ONE PERSON. Squares answer "who holds tickets"; contributions
// answer "who gave money". Built from squares alone, the card was titled
// "Contributors" and answered the first question, so a host who had just taken
// a donation read "Nobody has claimed a ticket yet" as nothing having happened.
//
// Keyed on the lowercased email, which is the same aggregation the square-only
// version used: someone who bought twice is one row, and someone who bought
// tickets and also donated is one person who did both.
//
// Separated from the page so the merge can be tested against real rows.
// The queries stay in the page; only the folding lives here.

export interface ContributorRow {
  name: string;
  email: string;
  tickets: number;
  /** Gave money outside the ticket price — on its own, or added to a purchase. */
  donated: boolean;
  /** Earliest activity, ISO. Null on old square rows that predate claimedAt. */
  claimedAt: string | null;
  status: "CONFIRMED" | "AWAITING" | "MIXED";
}

export interface SquareInput {
  playerName: string | null;
  playerEmail: string | null;
  paymentStatus: string;
  claimedAt: Date | null;
}

export interface DonationInput {
  contributorName: string;
  contributorEmail: string | null;
  status: string;
  createdAt: Date;
}

/**
 * Fold one settled/outstanding item into the row for its email.
 *
 * `settled` is CONFIRMED-worthy. Anything outstanding keeps the row off
 * CONFIRMED and flips it to MIXED, because a host chasing money must not see a
 * green row with an unpaid item behind it.
 */
function fold(
  rows: Map<string, ContributorRow>,
  email: string,
  name: string,
  settled: boolean,
  iso: string | null,
  kind: "ticket" | "donation"
) {
  const existing = rows.get(email);
  if (!existing) {
    rows.set(email, {
      name,
      email,
      // A DONATION TAKES NO INVENTORY (invariant 64), so it contributes no
      // tickets. The list renders a marker rather than a zero.
      tickets: kind === "ticket" ? 1 : 0,
      donated: kind === "donation",
      claimedAt: iso,
      status: settled ? "CONFIRMED" : "AWAITING",
    });
    return;
  }
  if (kind === "ticket") existing.tickets++;
  else existing.donated = true;
  if (iso && (!existing.claimedAt || iso < existing.claimedAt)) {
    existing.claimedAt = iso;
  }
  const wanted = settled ? "CONFIRMED" : "AWAITING";
  if (existing.status !== wanted) existing.status = "MIXED";
}

/**
 * `squares` must already be filtered to paid/reserved_cash with an email;
 * `donations` to confirmed/pending, unvoided, with a donation amount and an
 * email. Both filters live in the page query — a released or voided
 * contribution is not a contributor, and `voidedAt` never changes `status`,
 * so both halves have to be tested there.
 */
export function contributorRows(
  squares: SquareInput[],
  donations: DonationInput[]
): ContributorRow[] {
  const rows = new Map<string, ContributorRow>();

  for (const sq of squares) {
    if (!sq.playerEmail) continue;
    fold(
      rows,
      sq.playerEmail.toLowerCase(),
      sq.playerName ?? "—",
      sq.paymentStatus === "paid",
      sq.claimedAt ? sq.claimedAt.toISOString() : null,
      "ticket"
    );
  }

  for (const d of donations) {
    if (!d.contributorEmail) continue;
    fold(
      rows,
      d.contributorEmail.toLowerCase(),
      d.contributorName,
      d.status === "confirmed",
      d.createdAt.toISOString(),
      "donation"
    );
  }

  return Array.from(rows.values());
}
