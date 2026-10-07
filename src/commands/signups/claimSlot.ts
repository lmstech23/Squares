import { prisma } from '@/lib/prisma'
import { runCommand } from '@/lib/commands/runCommand'
import { actorStamp } from '@/lib/commands/authorize'
import { fail, ok, type Command } from '@/lib/commands/types'
import { validateQuantity } from '@/domain/signups'
import { isPlausibleEmail } from '@/domain/identity'
import { resolveEventPerson } from '@/db/eventPerson'
import { claimPositions } from '@/db/signups'

export type ClaimSlotInput = {
  slotId: string
  name: string
  email: string
  phone?: string | null
  quantity: number
  note?: string | null
}

export type ClaimSlotResult = {
  helperSignupId: string
  eventPersonId: string
  slotId: string
  positions: number[]
}

export const claimSlot: Command<ClaimSlotInput, ClaimSlotResult> = async (input, ctx) => {
  if (!input.name?.trim()) return fail('VALIDATION_FAILED', 'Please add your name.', [{ field: 'name', message: 'Required.' }])
  if (!isPlausibleEmail(input.email ?? '')) return fail('VALIDATION_FAILED', 'Please add a valid email.', [{ field: 'email', message: 'Required.' }])

  const slot = await prisma.daaliSignupSlot.findUnique({
    where: { id: input.slotId },
    select: {
      id: true, slotType: true, capacity: true, name: true,
      sheet: { select: { isOpen: true, event: { select: { id: true, status: true } } } },
    },
  })
  if (!slot) return fail('NOT_FOUND', 'That sign-up is no longer available.')
  if (!slot.sheet.isOpen) return fail('CONFLICT', 'Sign-ups are closed for this event.')

  const quantityError = validateQuantity(slot.slotType, input.quantity)
  if (quantityError) return fail('VALIDATION_FAILED', quantityError, [{ field: 'quantity', message: quantityError }])

  return runCommand({
    name: 'claimSlot',
    input,
    ctx,
    eventId: slot.sheet.event.id,
    execute: async (tx) => {
      // NO RSVP PREREQUISITE. The parent who can't attend but is dropping off two
      // cases of water is a real person and belongs on the roster. Requiring an
      // RSVP first would reintroduce the shape of the donor-eligibility rule with
      // a different gate.
      const person = await resolveEventPerson(tx, slot.sheet.event.id, input)

      const outcome = await claimPositions(tx, {
        slotId: slot.id,
        eventPersonId: person.id,
        quantity: input.quantity,
        capacity: slot.capacity,
        note: input.note,
        stamp: actorStamp(ctx.actor),
      })

      if (!outcome.ok) {
        return outcome.reason === 'FULL'
          ? fail<ClaimSlotResult>('CONFLICT', `Only ${outcome.remaining} left on "${slot.name}".`, { remaining: outcome.remaining })
          : fail<ClaimSlotResult>('CONFLICT', 'Several people signed up at once. Try again.')
      }

      await tx.daaliSignupLog.create({
        data: {
          slotId: slot.id,
          eventPersonId: person.id,
          action: 'CLAIMED',
          positions: outcome.positions.length,
          ...actorStamp(ctx.actor),
          actorEventPersonId: ctx.actor.eventPersonId ?? person.id,
        },
      })

      return ok({
        helperSignupId: outcome.helperSignupId,
        eventPersonId: person.id,
        slotId: slot.id,
        positions: outcome.positions,
      })
    },
  })
}
