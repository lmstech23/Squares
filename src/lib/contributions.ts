import type { Prisma } from "@prisma/client";
// RELATIVE, WITH EXTENSIONS, not the "@/" alias - same reason board-lock.ts
// uses them. `node --experimental-strip-types --test` does not read tsconfig
// paths, so a module importing "@/lib/..." cannot be loaded by a plain
// `npm test` at all: it dies with ERR_MODULE_NOT_FOUND before the first
// assertion, even in a file whose suite would have skipped. boardTotals owns
// the raised total on three surfaces and has to be testable.
import { prisma } from "./prisma.ts";
import { resolveSupporter } from "./admission.ts";

// Contributions — fundraiser-donations-addendum.md v2.3, invariants 51-70.
//
// The money primitive. Every dollar the system counts belongs to exactly one
// Contribution row (invariant 51).
//
//   money -> square   -> position, drawing eligibility, admission
//   money -> donation -> nothing but the money
//
// THREE NUMBERS, NEVER ONE (§1). squareAmountCents, donationAmountCents and
// totalPaidCents are stored separately and the CHECK constraint enforces the
// sum. Collapsing them loses the prize basis irrecoverably.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO. Donations §5 says
// "Contribution.id IS the batch identity. Replaces Square.batchId." A1 did not
// perform that replacement: it added `contributionId` alongside `batchId` and
// retained `batchId` as the reconstruction source. Retiring `batchId` tonight
// would touch admission, pass minting, the confirmation email, the passes
// screen, the hold-resolution cron and the host panel — every one of which is
// a "keeps working unchanged" requirement. So squares are linked through
// `contributionId` and everything that reads `batchId` today keeps reading it.
// The rename is a separate migration, not a side effect of shipping donations.

/**
 * THE ONLY DEFINITION OF "COUNTS TOWARD RAISED" — donations §7.
 *
 * `raisedCents` is `status = 'confirmed' AND voidedAt IS NULL`. Any query that
 * forgets the second predicate silently returns voided money in a total and
 * nothing fails loudly, which is exactly why this lives in one place.
 */
export const countsTowardRaised = {
  status: "confirmed",
  voidedAt: null,
} satisfies Prisma.ContributionWhereInput;

/**
 * Minimum card donation — donations §6. Below $5 Stripe's per-transaction cost
 * consumes most of the gift. Enforced server-side, not only in the picker.
 * Cash donations have no minimum: the host is recording money already in hand.
 */
export const MIN_CARD_DONATION_CENTS = 500;

/** Presets offered by the amount picker — donations §6. `Other` is a peer. */
export const DONATION_PRESETS_CENTS = [1000, 2500, 5000, 10000];

export interface BoardTotals {
  /** Confirmed square money. What prize math multiplies against (invariant 57). */
  squareCents: number;
  /** Confirmed donation money. Never reaches the prize basis. */
  donationCents: number;
  /** squareCents + donationCents. The public number (invariant 51). */
  raisedCents: number;
  /** Alias of squareCents, named for the invariant that reads it. */
  prizeBasisCents: number;
  contributionCount: number;
}

/**
 * The host dashboard's four numbers — donations §11.
 *
 * One grouped read over the ledger, which is the payoff for making Contribution
 * the primitive. Voided cash donations are excluded here and permanently.
 */
export async function boardTotals(boardId: string): Promise<BoardTotals> {
  const agg = await prisma.contribution.aggregate({
    where: { boardId, ...countsTowardRaised },
    _sum: { squareAmountCents: true, donationAmountCents: true, totalPaidCents: true },
    _count: true,
  });
  const squareCents = agg._sum.squareAmountCents ?? 0;
  const donationCents = agg._sum.donationAmountCents ?? 0;
  return {
    squareCents,
    donationCents,
    raisedCents: agg._sum.totalPaidCents ?? 0,
    prizeBasisCents: squareCents,
    contributionCount: agg._count,
  };
}

/**
 * Create the pending contribution for a card checkout, inside the same
 * transaction that locks the squares.
 *
 * `holdExpiresAt` is null on a donation-only contribution — invariant 64.
 * Nothing is being held, and a countdown would be a lie.
 */
export async function createPendingCardContribution(
  tx: Prisma.TransactionClient,
  input: {
    boardId: string;
    squareAmountCents: number;
    donationAmountCents: number;
    contributorName: string;
    contributorEmail: string;
    contributorPhone?: string | null;
    /// Sign-up interest. Entitlement-free - no grant, no pass. See the schema.
    wantsToHelp?: boolean;
    holdExpiresAt: Date | null;
  }
) {
  const total = input.squareAmountCents + input.donationAmountCents;
  return tx.contribution.create({
    data: {
      boardId: input.boardId,
      status: "pending",
      paymentMethod: "stripe",
      squareAmountCents: input.squareAmountCents,
      donationAmountCents: input.donationAmountCents,
      totalPaidCents: total,
      contributorName: input.contributorName,
      contributorEmail: input.contributorEmail,
      contributorPhone: input.contributorPhone || null,
      wantsToHelp: input.wantsToHelp ?? false,
      // Only squares are inventory. A donation-only contribution holds nothing.
      holdExpiresAt: input.squareAmountCents > 0 ? input.holdExpiresAt : null,
    },
  });
}

/**
 * Activate the donor as an EventSupporter — donations §9, amending admission §5.
 *
 * A donation-only contribution never flips a square, so without this the donor
 * stays `pending` forever, which silently makes them ineligible for helper
 * signups. Zero grants and zero passes: supporter existence never implies
 * entitlement (invariant 69).
 *
 * The compare-and-swap is unchanged and still required — a donation and a
 * square purchase from the same person can confirm concurrently and only one
 * transaction may do the activation work.
 */
export async function activateDonorSupporter(
  tx: Prisma.TransactionClient,
  eventId: string,
  /// phone is REQUIRED, like email. Both are mandatory on every contribution
  /// now, and the type is what stops a partial identity reaching the roster.
  contact: { name: string; email: string; phone: string }
) {
  const supporter = await resolveSupporter(tx, eventId, contact);
  await tx.eventSupporter.updateMany({
    where: { id: supporter.id, status: "pending" },
    data: { status: "active", activatedAt: new Date() },
  });
  return supporter;
}

// Plain fields, not TypeScript parameter properties. `node
// --experimental-strip-types` — which runs this repo's test suite and its
// scripts — rejects parameter properties outright, so a constructor shorthand
// here would break every runner that imports this module.
export class ContributionAmountMismatch extends Error {
  expected: number;
  actual: number;
  constructor(expected: number, actual: number) {
    super(`Contribution amount mismatch: expected ${expected}, session says ${actual}`);
    this.name = "ContributionAmountMismatch";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Confirm a card contribution from its Stripe session — invariants 62 and 63.
 *
 * Idempotent by conditional update on `status = 'pending'`. A replayed webhook
 * matches zero rows and changes nothing, which the caller reads as
 * `alreadyHandled`.
 *
 * The amount assertion is invariant 62: `amount_total` must equal
 * `totalPaidCents`. A mismatch does not confirm, does not release, and raises.
 * Amounts stay authoritative from the row and are never read back from Stripe.
 */
export async function confirmCardContribution(
  tx: Prisma.TransactionClient,
  sessionId: string,
  amountTotal: number | null
): Promise<
  | { found: false }
  | { found: true; alreadyHandled: true; contributionId: string }
  | { found: true; alreadyHandled: false; contributionId: string; boardId: string;
      donationAmountCents: number; squareAmountCents: number;
      contributorName: string; contributorEmail: string | null; contributorPhone: string | null }
> {
  const row = await tx.contribution.findUnique({
    where: { checkoutSessionId: sessionId },
  });
  if (!row) return { found: false };

  if (amountTotal != null && amountTotal !== row.totalPaidCents) {
    throw new ContributionAmountMismatch(row.totalPaidCents, amountTotal);
  }

  const { count } = await tx.contribution.updateMany({
    where: { id: row.id, status: "pending" },
    data: { status: "confirmed", confirmedAt: new Date() },
  });

  if (count === 0) return { found: true, alreadyHandled: true, contributionId: row.id };

  return {
    found: true,
    alreadyHandled: false,
    contributionId: row.id,
    boardId: row.boardId,
    donationAmountCents: row.donationAmountCents,
    squareAmountCents: row.squareAmountCents,
    contributorName: row.contributorName,
    contributorEmail: row.contributorEmail,
    contributorPhone: row.contributorPhone,
  };
}

/**
 * Release a pending contribution — the other half of invariant 60.
 *
 * Conditional on `status = 'pending'`, so a session that completed and a
 * session that expired cannot both win. Never touches a confirmed row.
 */
export async function releaseContributionBySession(sessionId: string): Promise<number> {
  const { count } = await prisma.contribution.updateMany({
    where: { checkoutSessionId: sessionId, status: "pending" },
    data: { status: "released", releasedAt: new Date() },
  });
  return count;
}

/**
 * Record a cash donation — donations §7, invariant 65.
 *
 * One host action. Recorded `confirmed` immediately, attributed to the
 * recording host. There is no reserve step because there is nothing to
 * reserve: a cash donation holds no inventory, so a hold would be a state with
 * no purpose and an expiry with nothing to expire.
 *
 * Email is optional here and only here (§10): EventSupporter.email is NOT NULL,
 * so a cash donation with no email is a Contribution and nothing else. Forcing
 * a fake email to satisfy a constraint is worse.
 */
export async function recordCashDonation(input: {
  boardId: string;
  eventId: string | null;
  amountCents: number;
  contributorName: string;
  contributorEmail: string | null;
  contributorPhone: string | null;
  recordedByHostId: string;
  isHostEntry: boolean;
}) {
  return prisma.$transaction(async (tx) => {
    const contribution = await tx.contribution.create({
      data: {
        boardId: input.boardId,
        status: "confirmed",
        paymentMethod: "cash",
        squareAmountCents: 0,
        donationAmountCents: input.amountCents,
        totalPaidCents: input.amountCents,
        contributorName: input.contributorName,
        contributorEmail: input.contributorEmail,
        contributorPhone: input.contributorPhone,
        isHostEntry: input.isHostEntry,
        confirmedAt: new Date(),
        recordedByHostId: input.recordedByHostId,
        confirmedByHostId: input.recordedByHostId,
      },
    });

    // Both are required by the routes above; the guard is a backstop, not a
    // branch that a legitimate contribution can fall down.
    if (input.eventId && input.contributorEmail && input.contributorPhone) {
      await activateDonorSupporter(tx, input.eventId, {
        name: input.contributorName,
        email: input.contributorEmail,
        phone: input.contributorPhone,
      });
    }

    return contribution;
  });
}
