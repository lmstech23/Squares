import { prisma } from '@/lib/prisma'
import { runCommand, isUniqueViolation } from '@/lib/commands/runCommand'
import { requireOrganizer, requireOwnership } from '@/lib/commands/authorize'
import { fail, ok, type Command } from '@/lib/commands/types'
import { canTransition } from '@/domain/eventStatus'
import { validateForPublish } from '@/domain/eventValidation'
import { candidateSlug } from '@/domain/slug'

export type PublishEventInput = { eventId: string }
export type PublishEventResult = { eventId: string; slug: string; publishedAt: string }

const SLUG_ATTEMPTS = 5

export const publishEvent: Command<PublishEventInput, PublishEventResult> = async (input, ctx) => {
  const denied = requireOrganizer<PublishEventResult>(ctx.actor)
  if (denied) return denied

  const event = await prisma.daaliEvent.findUnique({
    where: { id: input.eventId },
    select: {
      id: true, organizerUserId: true, status: true, slug: true,
      publishedAt: true, title: true, startsAt: true, timezone: true,
    },
  })
  if (!event) return fail('NOT_FOUND', 'That event no longer exists.')

  const notYours = requireOwnership<PublishEventResult>(ctx.actor, event)
  if (notYours) return notYours

  // Idempotent by nature, not just by key: re-publishing returns the existing slug.
  if (event.status === 'PUBLISHED' && event.slug && event.publishedAt) {
    return ok({ eventId: event.id, slug: event.slug, publishedAt: event.publishedAt.toISOString() })
  }

  if (!canTransition(event.status, 'PUBLISHED')) {
    return fail('ILLEGAL_TRANSITION', `A ${event.status.toLowerCase()} event cannot be published.`)
  }

  const errors = validateForPublish(event)
  if (errors.length) return fail('VALIDATION_FAILED', 'This event is not ready to go live.', errors)

  const publishedAt = ctx.now ?? new Date()

  return runCommand({
    name: 'publishEvent',
    input,
    ctx,
    eventId: event.id,
    execute: async (tx) => {
      // Do not "check if taken, then insert" — that races. Try and retry.
      for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
        try {
          const updated = await tx.daaliEvent.update({
            where: { id: event.id },
            data: { slug: candidateSlug(event.title), status: 'PUBLISHED', publishedAt },
            select: { id: true, slug: true, publishedAt: true },
          })
          return ok({
            eventId: updated.id,
            slug: updated.slug!,
            publishedAt: updated.publishedAt!.toISOString(),
          })
        } catch (e) {
          if (isUniqueViolation(e) && attempt < SLUG_ATTEMPTS - 1) continue
          throw e
        }
      }
      return fail<PublishEventResult>('CONFLICT', 'Could not assign a unique link. Try again.')
    },
  })
}
