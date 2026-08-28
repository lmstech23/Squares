import type { Prisma } from "@prisma/client";

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
  donateAdmissions: boolean
) {
  const supporter = await resolveSupporter(tx, eventId, contact);
  await createGrant(tx, {
    eventId,
    eventSupporterId: supporter.id,
    squareBatchId,
    donateAdmissions,
  });
  return supporter;
}
