import { prisma } from '@/lib/prisma'
import { runCommand } from '@/lib/commands/runCommand'
import { actorStamp, effectiveUserId } from '@/lib/commands/authorize'
import { fail, ok, type Command } from '@/lib/commands/types'

export type CancelRegistrationInput = { registrationId: string }
export type CancelRegistrationResult = { registrationId: string; status: 'CANCELLED'; seatsFreed: number }

/**
 * One command for both cancellers. The participant cancels their own; the
 * organizer removes someone. Authorization differs, the domain operation does not
 * — and the actor stamp is what tells them apart afterwards.
 */
export const cancelRegistration: Command<CancelRegistrationInput, CancelRegistrationResult> =
  async (input, ctx) => {
    const reg = await prisma.daaliRegistration.findUnique({
      where: { id: input.registrationId },
      select: {
        id: true, status: true, partySize: true, eventPersonId: true,
        event: { select: { id: true, organizerUserId: true } },
      },
    })
    if (!reg) return fail('NOT_FOUND', 'That RSVP no longer exists.')

    const isOwnRegistration = ctx.actor.eventPersonId === reg.eventPersonId
    const isOrganizer = effectiveUserId(ctx.actor) === reg.event.organizerUserId
    if (!isOwnRegistration && !isOrganizer) {
      return fail('FORBIDDEN', 'You cannot change this RSVP.')
    }

    if (reg.status === 'CANCELLED') {
      return ok({ registrationId: reg.id, status: 'CANCELLED' as const, seatsFreed: 0 })
    }

    return runCommand({
      name: 'cancelRegistration',
      input,
      ctx,
      eventId: reg.event.id,
      execute: async (tx) => {
        const stamp = actorStamp(ctx.actor)
        await tx.daaliRegistration.update({
          where: { id: reg.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: ctx.now ?? new Date(),
            cancelledByKind: stamp.actorKind,
            cancelledByUserId: stamp.actorUserId,
            cancelledByEventPersonId: stamp.actorEventPersonId,
            cancelledByPlanId: stamp.planExecutionId,
          },
        })
        await tx.daaliRegistrationLog.create({
          data: {
            registrationId: reg.id,
            eventId: reg.event.id,
            eventPersonId: reg.eventPersonId,
            action: isOwnRegistration ? 'CANCELLED' : 'ORGANIZER_REMOVED',
            fromPartySize: reg.partySize,
            toPartySize: 0,
            ...stamp,
          },
        })

        // Seats free automatically: the count derives from CONFIRMED rows.
        // There is no counter to decrement.
        return ok({ registrationId: reg.id, status: 'CANCELLED' as const, seatsFreed: reg.partySize })
      },
    })
  }
