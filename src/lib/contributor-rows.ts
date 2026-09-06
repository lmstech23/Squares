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
}

export interface DonationInput {
  contributorName: string;
  contributorEmail: string | null;
  contributorPhone: string | null;
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
  index: RowIndex,
  emailKey: string,
  phoneKey: string | null,
  name: string,
  settled: boolean,
  iso: string | null,
  kind: "ticket" | "donation"
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
      tickets: kind === "ticket" ? 1 : 0,
      donated: kind === "donation",
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
  if (kind === "ticket") existing.tickets++;
  else existing.donated = true;
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
  donations: DonationInput[]
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
      "ticket"
    );
  }

  for (const d of donations) {
    const emailKey = normalizeEmail(d.contributorEmail);
    if (!emailKey) continue;
    fold(
      index,
      emailKey,
      normalizePhone(d.contributorPhone),
      d.contributorName,
      d.status === "confirmed",
      d.createdAt.toISOString(),
      "donation"
    );
  }

  return index.rows;
}
