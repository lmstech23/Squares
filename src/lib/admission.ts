import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Admission — fundraiser-admission-addendum.md v2.0.
//
// The only module permitted to create supporters, grants, or passes. Nothing
// else touches those tables directly.
//
// Every writer takes a transaction handle, without exception. Preparation runs
// inside the same transaction that creates the squares, so a claim that fails
// leaves no orphaned supporter behind.
//
// Phase A scope is preparation only (§4). Minting happens at confirmation and
// is A8 — nothing here creates an AdmissionPass.

/** Purchaser email, lowercased and trimmed. The supporter identity. */
export function normalizeIdentityKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Find the supporter for this email on this event, or create one as `pending`.
 *
 * One family, one row, across every purchase they make — the unique index on
 * (eventId, identityKey) is what enforces it. Two different emails are two
 * supporters, which is a known and accepted weakness: this is a headcount
 * control for a school tailgate, not a security boundary.
 *
 * `name` and `email` are NOT NULL with no default, so both are required here.
 * `phone` is nullable, matching how Square.playerPhone already behaves.
 */
export async function resolveSupporter(
  tx: Prisma.TransactionClient,
  eventId: string,
  contact: { name: string; email: string; phone?: string | null }
) {
  const identityKey = normalizeIdentityKey(contact.email);

  const existing = await tx.eventSupporter.findUnique({
    where: { eventId_identityKey: { eventId, identityKey } },
  });

  // A returning supporter keeps their status and their passes. Never
  // downgrade an active supporter back to pending on a later purchase.
  if (existing) return existing;

  return tx.eventSupporter.create({
    data: {
      eventId,
      identityKey,
      name: contact.name.trim(),
      email: identityKey,
      phone: contact.phone?.trim() || null,
    },
  });
}

/**
 * Record one purchase's contribution to a supporter.
 *
 * A grant is written even when it donates its admissions, so the host's
 * headcount is auditable rather than inferred from absence.
 *
 * Idempotent by constraint: `squareBatchId` is unique, so a retried claim
 * cannot write a second grant for the same batch. The retry returns the
 * existing row rather than failing the whole claim.
 */
export async function createGrant(
  tx: Prisma.TransactionClient,
  input: {
    eventId: string;
    eventSupporterId: string;
    squareBatchId: string;
    donateAdmissions: boolean;
    /// Sign-up addendum SS3: INTENT, never entitlement. Eligibility to claim a
    /// slot is derived from EventSupporter.status = active, not from this flag.
    /// This only records that they asked, which is what the redirect keys on.
    wantsToHelp?: boolean;
  }
) {
  const existing = await tx.admissionGrant.findUnique({
    where: { squareBatchId: input.squareBatchId },
  });
  if (existing) return existing;

  return tx.admissionGrant.create({
    data: {
      eventId: input.eventId,
      eventSupporterId: input.eventSupporterId,
      squareBatchId: input.squareBatchId,
      source: "FUNDRAISER",
      donateAdmissions: input.donateAdmissions,
      wantsToHelp: input.wantsToHelp ?? false,
    },
  });
}

/**
 * Preparation at claim time — addendum §4.
 *
 * Runs in the same transaction as the square writes, on boards with an event.
 * No passes yet: a pending supporter owns zero pass records. Passes are minted
 * one per square at confirmation (A8).
 */
export async function prepareAdmission(
  tx: Prisma.TransactionClient,
  eventId: string,
  squareBatchId: string,
  contact: { name: string; email: string; phone?: string | null },
  donateAdmissions: boolean,
  wantsToHelp = false
) {
  const supporter = await resolveSupporter(tx, eventId, contact);
  await createGrant(tx, {
    eventId,
    eventSupporterId: supporter.id,
    squareBatchId,
    donateAdmissions,
    wantsToHelp,
  });
  return supporter;
}

/**
 * Abandoned-claim cleanup — addendum §4.
 *
 * When a batch is released: if its grant has no remaining live squares, delete
 * the grant; if the supporter is then `pending` with no grants left, delete the
 * supporter. **Active supporters are never touched** — an active supporter owns
 * passes, and passes outlive the campaign.
 *
 * Without this, every abandoned claim sits in the host's unpaid forecast
 * permanently and she orders food for people who never paid.
 *
 * Keyed on "this grant has no live squares" rather than on the release event
 * itself, because a batch can lose its squares without being released: the
 * checkout merge path re-batches earlier squares onto a new id, which strips
 * the old grant of squares while nothing is ever released. A cleanup that only
 * fires on release would never reach those.
 */
export async function releaseAdmissionForBatch(
  squareBatchId: string
): Promise<{ grantsDeleted: number; supportersDeleted: number }> {
  const grant = await prisma.admissionGrant.findUnique({
    where: { squareBatchId },
    select: { id: true, eventSupporterId: true },
  });

  if (!grant) return { grantsDeleted: 0, supportersDeleted: 0 };

  // A square is "live" if it still exists in a state that could become paid,
  // or already is. Released squares have had their batchId cleared, so this
  // count naturally falls to zero once the batch is released.
  const liveSquares = await prisma.square.count({
    where: {
      batchId: squareBatchId,
      paymentStatus: { in: ["pending", "reserved_cash", "paid"] },
    },
  });

  if (liveSquares > 0) return { grantsDeleted: 0, supportersDeleted: 0 };

  await prisma.admissionGrant.delete({ where: { id: grant.id } });

  const supporter = await prisma.eventSupporter.findUnique({
    where: { id: grant.eventSupporterId },
    select: {
      id: true,
      status: true,
      _count: { select: { grants: true, signups: true } },
    },
  });

  // Active means she has passes. Never delete her, whatever else is true.
  //
  // A supporter holding ANY HelperSignup is never deleted either, at any
  // status — sign-up addendum §9, invariant 42. With donors-only absolute this
  // clause is unreachable today: every helper is `active`, and the status check
  // above already stops there. It is here anyway as the safety net for any
  // future path that lets a non-active supporter hold a commitment. Deleting a
  // supporter out from under a live commitment is the kind of thing that gets
  // discovered at 6am on event day.
  if (
    !supporter ||
    supporter.status !== "pending" ||
    supporter._count.grants > 0 ||
    supporter._count.signups > 0
  ) {
    return { grantsDeleted: 1, supportersDeleted: 0 };
  }

  await prisma.eventSupporter.delete({ where: { id: supporter.id } });
  return { grantsDeleted: 1, supportersDeleted: 1 };
}
