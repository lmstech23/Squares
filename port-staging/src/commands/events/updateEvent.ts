import { prisma } from '@/lib/prisma'
import { runCommand } from '@/lib/commands/runCommand'
import { requireOrganizer, requireOwnership } from '@/lib/commands/authorize'
import { fail, ok, type Command } from '@/lib/commands/types'
import { validateEventDraft } from '@/domain/eventValidation'
import { immutableReason } from '@/capabilities/eventCore'
import { lockEventForSeating, seatsTaken } from '@/db/capacity'

export type UpdateEventInput = {
  eventId: string
  patch: {
    title?: string
    description?: string | null
    startsAt?: Date
    endsAt?: Date | null
    timezone?: string
    venueName?: string | null
    venueAddress?: string | null
    capacity?: number | null
  }
}

export type UpdateEventResult = { eventId: string; updatedAt: string }

export const updateEvent: Command<UpdateEventInput, UpdateEventResult> = async (input, ctx) => {
  const denied = requireOrganizer<UpdateEventResult>(ctx.actor)
  if (denied) return denied

  const event = await prisma.event.findUnique({
    where: { id: input.eventId },
    select: {
      id: true, organizerUserId: true, status: true, publishedAt: true,
      _count: { select: { registrations: { where: { status: 'CONFIRMED' } } } },
    },
  })
  if (!event) return fail('NOT_FOUND', 'That event no longer exists.')

  const notYours = requireOwnership<UpdateEventResult>(ctx.actor, event)
  if (notYours) return notYours

  // The capability contract decides what may still change. The same rules the
  // organizer edit form uses to disable its inputs.
  const state = {
    status: event.status,
    publishedAt: event.publishedAt,
    registrationCount: event._count.registrations,
  }
  for (const field of Object.keys(input.patch)) {
    const reason = immutableReason(field, state)
    if (reason) return fail('FIELD_IMMUTABLE', reason, { field })
  }

  const errors = validateEventDraft(input.patch)
  if (errors.length) return fail('VALIDATION_FAILED', 'Check the highlighted fields.', errors)

  return runCommand({
    name: 'updateEvent',
    input,
    ctx,
    eventId: event.id,
    execute: async (tx) => {
      // Field mutability said capacity MAY change. The command decides whether
      // this particular value is legal — you cannot shrink below the seats
      // already sold. Lock first so the check cannot race an in-flight RSVP.
      if (input.patch.capacity !== undefined && input.patch.capacity !== null) {
        await lockEventForSeating(tx, event.id)
        const taken = await seatsTaken(tx, event.id)
        if (input.patch.capacity < taken) {
          return fail<UpdateEventResult>(
            'VALIDATION_FAILED',
            `${taken} seat${taken === 1 ? ' is' : 's are'} already taken. Capacity cannot go below that.`,
            [{ field: 'capacity', message: `Minimum is ${taken}.` }],
          )
        }
      }

      const updated = await tx.event.update({
        where: { id: event.id },
        data: {
          ...(input.patch.title !== undefined ? { title: input.patch.title.trim() } : {}),
          ...(input.patch.description !== undefined ? { description: input.patch.description?.trim() || null } : {}),
          ...(input.patch.startsAt !== undefined ? { startsAt: input.patch.startsAt } : {}),
          ...(input.patch.endsAt !== undefined ? { endsAt: input.patch.endsAt } : {}),
          ...(input.patch.timezone !== undefined ? { timezone: input.patch.timezone } : {}),
          ...(input.patch.venueName !== undefined ? { venueName: input.patch.venueName?.trim() || null } : {}),
          ...(input.patch.venueAddress !== undefined ? { venueAddress: input.patch.venueAddress?.trim() || null } : {}),
          ...(input.patch.capacity !== undefined ? { capacity: input.patch.capacity } : {}),
        },
        select: { id: true, updatedAt: true },
      })
      return ok({ eventId: updated.id, updatedAt: updated.updatedAt.toISOString() })
    },
  })
}
