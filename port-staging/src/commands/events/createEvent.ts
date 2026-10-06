import { runCommand } from '@/lib/commands/runCommand'
import { requireOrganizer, effectiveUserId } from '@/lib/commands/authorize'
import { fail, ok, type Command } from '@/lib/commands/types'
import { validateEventDraft } from '@/domain/eventValidation'

export type CreateEventInput = {
  title: string
  startsAt: Date
  endsAt?: Date | null
  timezone: string
  description?: string | null
  venueName?: string | null
  venueAddress?: string | null
  capacity?: number | null
}

export type CreateEventResult = { eventId: string }

export const createEvent: Command<CreateEventInput, CreateEventResult> = async (input, ctx) => {
  const denied = requireOrganizer<CreateEventResult>(ctx.actor)
  if (denied) return denied

  const errors = validateEventDraft(input)
  if (errors.length) return fail('VALIDATION_FAILED', 'Check the highlighted fields.', errors)

  const organizerUserId = effectiveUserId(ctx.actor)!

  return runCommand({
    name: 'createEvent',
    input,
    ctx,
    execute: async (tx) => {
      const event = await tx.daaliEvent.create({
        data: {
          organizerUserId,
          title: input.title.trim(),
          startsAt: input.startsAt,
          endsAt: input.endsAt ?? null,
          timezone: input.timezone,
          description: input.description?.trim() || null,
          venueName: input.venueName?.trim() || null,
          venueAddress: input.venueAddress?.trim() || null,
          capacity: input.capacity ?? null,
          status: 'DRAFT',
        },
        select: { id: true },
      })
      return ok({ eventId: event.id })
    },
  })
}
