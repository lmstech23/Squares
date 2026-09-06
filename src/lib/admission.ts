import type { Prisma } from "@prisma/client";
import { identityKeys, normalizeEmail } from "./roster-identity.ts";
// Relative, with the extension - see the note in contributions.ts.
import { prisma } from "./prisma.ts";

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
/**
 * @deprecated Superseded by normalizeEmail in roster-identity.ts, which is the
 * single owner of normalization. Kept as a thin alias so nothing has two
 * implementations to choose between while call sites migrate.
 */
export function normalizeIdentityKey(email: string): string {
  return normalizeEmail(email) ?? "";
}

/**
 * Find the supporter for this contact on this event, or create one.
 *
 * ORDERED LOOKUP, EMAIL THEN PHONE, NEVER OR. Two point reads against two
 * unique indexes, in that order. `email OR phone` would chain transitively:
 * A shares an email with B, B shares a phone with C, and C is silently merged
 * into A. This binds to AT MOST ONE existing supporter and never merges two
 * that already exist.
 *
 * NO TIE-BREAK, and none is possible: both keys are uniquely indexed within an
 * event, so each lookup returns one row or none. There is no set to order. If
 * this ever appears to need an ordering rule, the lookup is wrong.
 *
 * THE PHONE BRANCH IS NOT A FALLBACK FOR MISSING DATA - email and phone are
 * both mandatory now. It is how ONE PERSON WITH TWO EMAIL ADDRESSES STAYS ONE
 * SUPPORTER: a contribution with a new email and a known phone binds to the
 * existing supporter, creates no second row, and is not rejected. That is the
 * only path phone identity takes.
 *
 * On that branch `emailKey` is NOT overwritten. It is uniquely indexed and
 * rewriting it could collide with a third supporter; the new address is on the
 * Contribution, which is where the ledger keeps what was typed.
 *
 * A returning supporter keeps their status and their passes. Never downgrade
 * an active supporter back to pending on a later purchase.
 */
export async function resolveSupporter(
  tx: Prisma.TransactionClient,
  eventId: string,
  contact: { name: string; email: string; phone: string }
) {
  const keys = identityKeys(contact);
  if ("error" in keys) {
    // The routes validate first and give a human message; this is the
    // backstop that keeps a partial identity from ever reaching the table.
    throw new Error(`resolveSupporter: ${keys.error} is required`);
  }

  const found = await lookupSupporter(tx, eventId, keys);
  if (found) return found;

  // CREATE, GUARDED BY A SAVEPOINT.
  //
  // Two concurrent claims for the same new contact both miss the lookup and
  // both insert; one gets a unique violation. Catching it is not enough on
  // its own: in Postgres a failed statement ABORTS the surrounding
  // transaction, and every later statement fails with "current transaction is
  // aborted". Verified against a real database - the naive catch-and-requery
  // fails, the savepoint version commits.
  //
  // So: savepoint, insert, and on violation roll back to the savepoint and
  // re-run THE SAME ORDERED LOOKUP, binding to whichever row won. Once, then
  // throw. Not a loop, not a single-key upsert, and no new identity behaviour.
  await tx.$executeRawUnsafe("SAVEPOINT resolve_supporter");
  try {
    const created = await tx.eventSupporter.create({
      data: {
        eventId,
        emailKey: keys.emailKey,
        phoneKey: keys.phoneKey,
        name: contact.name.trim(),
        // WHAT THEY TYPED, not the normalized value. emailKey carries the
        // normalization now, so this no longer has to.
        email: contact.email.trim(),
        phone: contact.phone.trim(),
      },
    });
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT resolve_supporter");
    return created;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT resolve_supporter");
    const won = await lookupSupporter(tx, eventId, keys);
    if (won) return won;
    // A unique violation with nothing to find afterwards is not a race; it is
    // a constraint we do not understand. Do not retry into it.
    throw err;
  }
}

/** The ordered lookup, used by both the first attempt and the retry. */
async function lookupSupporter(
  tx: Prisma.TransactionClient,
  eventId: string,
  keys: { emailKey: string; phoneKey: string }
) {
  const byEmail = await tx.eventSupporter.findUnique({
    where: { eventId_emailKey: { eventId, emailKey: keys.emailKey } },
  });
  if (byEmail) return byEmail;

  return tx.eventSupporter.findUnique({
    where: { eventId_phoneKey: { eventId, phoneKey: keys.phoneKey } },
  });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
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
  contact: { name: string; email: string; phone: string },
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
