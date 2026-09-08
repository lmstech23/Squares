import { normalizeEmail, normalizePhone } from "./roster-identity.ts";

// One row per contributor for the host board page — v2 §9.
//
// TWO SOURCES, ONE PERSON. Squares answer "who holds tickets"; contributions
// answer "who gave money". Built from squares alone, the card was titled
// "Contributors" and answered the first question, so a host who had just taken
// a donation read "Nobody has claimed a ticket yet" as nothing having happened.
//
// FOLDED ON THE SHARED IDENTITY RULE, derived per render - email first, then
// phone, never OR. Same precedence admission.ts applies against the database,
// from the same module, so a host cannot see one person in her roster and two
// in this list.
//
// NO STORED KEY AND NO NEW ENTITY, deliberately. This is presentation. It must
// keep working on an event-less fundraiser board, where EventSupporter cannot
// exist at all - it is keyed on eventId with a non-null FK. Storing identity
// here would mean inventing a second identity table for boards that have no
// supporters.
//
// Separated from the page so the merge can be tested against real rows.
// The queries stay in the page; only the folding lives here.

export interface ContributorRow {
  name: string;
  email: string;
  tickets: number;
  /** Gave money outside the ticket price — on its own, or added to a purchase. */
  donated: boolean;
  /**
   * Ticket money, as recorded at purchase. NEVER count × the board's price.
   *
   * An early-bird ticket bought at $40 still reads $40 after the board moves to
   * $50 — invariant 48, and the reason both sources here are stored amounts:
   * `Square.pricePaidCents` for squares and `Contribution.entryAmountCents` for
   * standalone Entry Tickets, which is immutable after confirmation.
   */
  ticketCents: number;
  /** Donation money, from the stored `donationAmountCents`. */
  donationCents: number;
  /** Earliest activity, ISO. Null on old square rows that predate claimedAt. */
  claimedAt: string | null;
  status: "CONFIRMED" | "AWAITING" | "MIXED";
}

export interface SquareInput {
  playerName: string | null;
  playerEmail: string | null;
  playerPhone: string | null;
  paymentStatus: string;
  claimedAt: Date | null;
  /** What this square was sold for. Null on rows predating the column. */
  pricePaidCents: number | null;
}

/**
 * A ledger row: a donation, a standalone Entry Ticket purchase, or one that is
 * both.
 *
 * WAS `DonationInput`. It never only carried donations — a mixed purchase came
 * through here too — and it now carries entry money, which is the whole point
 * of this change. The name was describing the filter above it rather than the
 * row.
 */
export interface ContributionInput {
  contributorName: string;
  contributorEmail: string | null;
  contributorPhone: string | null;
  status: string;
  createdAt: Date;
  /** Standalone Entry Ticket money. Zero on a donation-only row. */
  entryAmountCents: number;
  /** Zero on an entry-only row. */
  donationAmountCents: number;
}

/**
 * One minted admission pass, for its COUNT only.
 *
 * WHY COUNT COMES FROM HERE AND MONEY DOES NOT. A `Contribution` records what
 * an entry purchase was worth but not how many tickets it bought — there is no
 * quantity column, and passes carry no `contributionId`, so a per-purchase
 * count is not derivable from the ledger alone. Passes are the tickets, so
 * counting them per person answers it.
 *
 * Taking the money from here as well would double-count it against
 * `entryAmountCents`. The amount stays on the ledger row; only the count comes
 * from here.
 *
 * SQUARE-MINTED PASSES ARE EXCLUDED BY THE CALLER (`squareId: null`), or a
 * square would be counted twice — once as a square and once as its pass.
 */
export interface PassInput {
  supporterEmail: string | null;
  supporterPhone: string | null;
}

/**
 * Fold one settled/outstanding item into the row for its email.
 *
 * `settled` is CONFIRMED-worthy. Anything outstanding keeps the row off
 * CONFIRMED and flips it to MIXED, because a host chasing money must not see a
 * green row with an unpaid item behind it.
 */
function fold(
  index: RowIndex,
  emailKey: string,
  phoneKey: string | null,
  name: string,
  settled: boolean,
  iso: string | null,
  /** What this item adds. Amounts are STORED values, never recomputed. */
  add: { tickets: number; ticketCents: number; donationCents: number }
) {
  // Email first, then phone - the shared precedence. A row with no phone
  // simply has no second key to match on; it is NEVER dropped and never
  // guessed at.
  const existing =
    index.byEmail.get(emailKey) ??
    (phoneKey ? index.byPhone.get(phoneKey) : undefined) ??
    null;
  if (!existing) {
    const row: ContributorRow = {
      name,
      email: emailKey,
      // A DONATION TAKES NO INVENTORY (invariant 64), so it contributes no
      // tickets. The list renders a marker rather than a zero.
      tickets: add.tickets,
      donated: add.donationCents > 0,
      ticketCents: add.ticketCents,
      donationCents: add.donationCents,
      claimedAt: iso,
      status: settled ? "CONFIRMED" : "AWAITING",
    };
    index.rows.push(row);
    // BOTH keys registered, so the next item can match on either. Registering
    // only the email is what would let one person become two rows the moment
    // they used a second address.
    index.byEmail.set(emailKey, row);
    if (phoneKey) index.byPhone.set(phoneKey, row);
    return;
  }
  existing.tickets += add.tickets;
  existing.ticketCents += add.ticketCents;
  existing.donationCents += add.donationCents;
  if (add.donationCents > 0) existing.donated = true;
  // A NEW ADDRESS ON A KNOWN PHONE now points at this row too, so a third
  // contribution on either key finds the same person.
  index.byEmail.set(emailKey, existing);
  if (phoneKey) index.byPhone.set(phoneKey, existing);
  if (iso && (!existing.claimedAt || iso < existing.claimedAt)) {
    existing.claimedAt = iso;
  }
  const wanted = settled ? "CONFIRMED" : "AWAITING";
  if (existing.status !== wanted) existing.status = "MIXED";
}

interface RowIndex {
  rows: ContributorRow[];
  byEmail: Map<string, ContributorRow>;
  byPhone: Map<string, ContributorRow>;
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
  contributions: ContributionInput[],
  /** Entry passes, for their count. Empty on a board with no event. */
  passes: PassInput[] = []
): ContributorRow[] {
  const index: RowIndex = { rows: [], byEmail: new Map(), byPhone: new Map() };

  // ORDER IS NOT ARBITRARY. Both lists are folded in the order the caller
  // supplies, and the caller orders by creation time, so the row a later
  // contribution merges into is the one that existed first - the same thing
  // the database lookup does.
  for (const sq of squares) {
    const emailKey = normalizeEmail(sq.playerEmail);
    // No email is not a contributor row this list can key at all - and the
    // page query already filters those out. Phone MAY be absent on a row that
    // predates the mandatory-both rule: that row is still SHOWN, it simply has
    // no second key, so nothing merges into it by phone. Skipping it would
    // silently drop a contributor from the roster, which is the failure this
    // whole list exists to prevent.
    if (!emailKey) continue;
    fold(
      index,
      emailKey,
      normalizePhone(sq.playerPhone),
      sq.playerName ?? "—",
      sq.paymentStatus === "paid",
      sq.claimedAt ? sq.claimedAt.toISOString() : null,
      // THE PRICE THIS SQUARE WAS SOLD AT, not today's. Null on rows that
      // predate the column: they still count as a ticket and add no money,
      // which is the same choice `claimedAt` already makes for old rows.
      { tickets: 1, ticketCents: sq.pricePaidCents ?? 0, donationCents: 0 }
    );
  }

  for (const c of contributions) {
    const emailKey = normalizeEmail(c.contributorEmail);
    if (!emailKey) continue;
    fold(
      index,
      emailKey,
      normalizePhone(c.contributorPhone),
      c.contributorName,
      c.status === "confirmed",
      c.createdAt.toISOString(),
      // NO TICKET COUNT HERE, and no square money either. The count comes from
      // passes below; `squareAmountCents` is deliberately not read, because
      // that same money is already on the square rows above and adding it here
      // would double it.
      {
        tickets: 0,
        ticketCents: c.entryAmountCents,
        donationCents: c.donationAmountCents,
      }
    );
  }

  // COUNT ONLY, and last. A pass always belongs to a confirmed purchase whose
  // ledger row was folded above, so this never creates a row on its own - and
  // `settled: true` matches that row's status rather than flipping it to MIXED.
  // `null` for the date leaves the earliest activity where the purchase put it.
  for (const p of passes) {
    const emailKey = normalizeEmail(p.supporterEmail);
    if (!emailKey) continue;
    fold(
      index,
      emailKey,
      normalizePhone(p.supporterPhone),
      "—",
      true,
      null,
      { tickets: 1, ticketCents: 0, donationCents: 0 }
    );
  }

  return index.rows;
}
