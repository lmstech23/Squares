import type { Prisma } from '@prisma/client'
import { allocatePositions } from '@/domain/signups'
import { isUniqueViolation } from '@/lib/commands/runCommand'

/**
 * THE SOLE OWNER OF CLAIMS.
 *
 * Nothing else may insert a HelperSignup or a HelperSignupPosition. The
 * one-position-per-SHIFT rule cannot be a database constraint (its predicate
 * needs slot.slotType from another table), so this file is the only place that
 * can enforce it.
 *
 * Capacity is enforced by the unique index on (slotId, position). Not a lock,
 * not a counter — there is no filledCount to drift.
 */

const MAX_CLAIM_ATTEMPTS = 5

export type ClaimOutcome =
  | { ok: true; helperSignupId: string; positions: number[] }
  | { ok: false; reason: 'FULL'; remaining: number }
  | { ok: false; reason: 'CONTENTION' }

export async function claimPositions(
  tx: Prisma.TransactionClient,
  args: {
    slotId: string
    eventPersonId: string
    quantity: number
    capacity: number
    note?: string | null
    stamp: {
      actorKind: 'HUMAN' | 'AGENT'
      actorUserId: string | null
      actorEventPersonId: string | null
      planExecutionId: string | null
    }
  },
): Promise<ClaimOutcome> {
  const { slotId, eventPersonId, quantity, capacity, note, stamp } = args

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    try {
      // One commitment per person per slot — enforced by the unique index, so
      // adding to an existing commitment is the only possible shape.
      const signup = await tx.helperSignup.upsert({
        where: { slotId_eventPersonId: { slotId, eventPersonId } },
        create: {
          slotId, eventPersonId,
          note: note?.trim() || null,
          actorKind: stamp.actorKind,
          actorUserId: stamp.actorUserId,
          actorEventPersonId: stamp.actorEventPersonId ?? eventPersonId,
          planExecutionId: stamp.planExecutionId,
        },
        update: note === undefined ? {} : { note: note?.trim() || null },
        select: { id: true },
      })

      const taken = await tx.helperSignupPosition.findMany({
        where: { slotId }, select: { position: true },
      })

      const positions = allocatePositions(taken.map((t) => t.position), capacity, quantity)
      if (!positions) {
        return { ok: false, reason: 'FULL', remaining: Math.max(0, capacity - taken.length) }
      }

      await tx.helperSignupPosition.createMany({
        data: positions.map((position) => ({ helperSignupId: signup.id, slotId, position })),
      })

      return { ok: true, helperSignupId: signup.id, positions }
    } catch (e) {
      if (!isUniqueViolation(e)) throw e

      // Lost a race for a position. Retry.
      //
      // The TERMINAL condition is "the slot is actually full", re-read at the top
      // of the loop — never "I have tried N times". A caller that gives up on
      // attempt count tells a helper the slot is full while positions remain,
      // which is exactly what the 4-way item contention test caught.
      if (attempt === MAX_CLAIM_ATTEMPTS - 1) return { ok: false, reason: 'CONTENTION' }
    }
  }
  return { ok: false, reason: 'CONTENTION' }
}

/**
 * Cancelling deletes the commitment; positions cascade and their NUMBERS BECOME
 * REUSABLE. This is a deliberate divergence from AdmissionPass.sequenceNumber,
 * which is monotonic and never reused because a pass is an entitlement and reuse
 * would be a security question. A slot position is a seat, not a credential.
 */
export async function releasePositions(
  tx: Prisma.TransactionClient,
  args: { helperSignupId: string; quantity?: number },
): Promise<number> {
  const { helperSignupId, quantity } = args

  if (quantity === undefined) {
    const { count } = await tx.helperSignupPosition.deleteMany({ where: { helperSignupId } })
    await tx.helperSignup.delete({ where: { id: helperSignupId } })
    return count
  }

  // Partial release on an ITEM — dropping from 4 cases to 2 deletes 2 position
  // rows and leaves the commitment standing. The displayed quantity follows
  // automatically because it was never stored.
  const doomed = await tx.helperSignupPosition.findMany({
    where: { helperSignupId }, orderBy: { position: 'desc' }, take: quantity, select: { id: true },
  })
  await tx.helperSignupPosition.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } })

  const left = await tx.helperSignupPosition.count({ where: { helperSignupId } })
  if (left === 0) await tx.helperSignup.delete({ where: { id: helperSignupId } })
  return doomed.length
}
