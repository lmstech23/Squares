import { prisma } from '@/lib/prisma'
import { runCommand } from '@/lib/commands/runCommand'
import { actorStamp, effectiveUserId } from '@/lib/commands/authorize'
import { fail, ok, type Command } from '@/lib/commands/types'
import { releasePositions } from '@/db/signups'

export type CancelClaimInput = { helperSignupId: string; quantity?: number }
export type CancelClaimResult = { helperSignupId: string; released: number; remainingHeld: number }

/** One command, two callers. The helper drops their own; the organizer removes someone. */
export const cancelClaim: Command<CancelClaimInput, CancelClaimResult> = async (input, ctx) => {
  const signup = await prisma.helperSignup.findUnique({
    where: { id: input.helperSignupId },
    select: {
      id: true, slotId: true, eventPersonId: true,
      _count: { select: { positions: true } },
      slot: { select: { sheet: { select: { event: { select: { id: true, organizerUserId: true } } } } } },
    },
  })
  if (!signup) return fail('NOT_FOUND', 'That sign-up no longer exists.')

  const isOwn = ctx.actor.eventPersonId === signup.eventPersonId
  const isOrganizer = effectiveUserId(ctx.actor) === signup.slot.sheet.event.organizerUserId
  if (!isOwn && !isOrganizer) return fail('FORBIDDEN', 'You cannot change this sign-up.')

  if (input.quantity !== undefined && (!Number.isInteger(input.quantity) || input.quantity < 1)) {
    return fail('VALIDATION_FAILED', 'Choose how many to drop.')
  }

  return runCommand({
    name: 'cancelClaim',
    input,
    ctx,
    eventId: signup.slot.sheet.event.id,
    execute: async (tx) => {
      const released = await releasePositions(tx, {
        helperSignupId: signup.id,
        quantity: input.quantity,
      })

      await tx.signupLog.create({
        data: {
          slotId: signup.slotId,
          eventPersonId: signup.eventPersonId,
          action: isOwn ? 'CANCELLED' : 'ORGANIZER_REMOVED',
          positions: released,
          ...actorStamp(ctx.actor),
        },
      })

      // A helper cancelling at 6am the day of an event is exactly the thing an
      // organizer will want to see and nobody will remember. The log is the
      // difference between "nobody showed up" and "three people cancelled
      // overnight."
      return ok({
        helperSignupId: signup.id,
        released,
        remainingHeld: signup._count.positions - released,
      })
    },
  })
}
