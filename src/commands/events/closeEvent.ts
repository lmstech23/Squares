import { prisma } from '@/lib/prisma'
import { runCommand } from '@/lib/commands/runCommand'
import { requireOrganizer, requireOwnership } from '@/lib/commands/authorize'
import { fail, ok, type Command } from '@/lib/commands/types'
import { canTransition } from '@/domain/eventStatus'

export type CloseEventInput = { eventId: string }
export type CloseEventResult = { eventId: string; status: 'CLOSED' }

export const closeEvent: Command<CloseEventInput, CloseEventResult> = async (input, ctx) => {
  const denied = requireOrganizer<CloseEventResult>(ctx.actor)
  if (denied) return denied

  const event = await prisma.daaliEvent.findUnique({
    where: { id: input.eventId },
    select: { id: true, organizerUserId: true, status: true },
  })
  if (!event) return fail('NOT_FOUND', 'That event no longer exists.')

  const notYours = requireOwnership<CloseEventResult>(ctx.actor, event)
  if (notYours) return notYours

  if (event.status === 'CLOSED') return ok({ eventId: event.id, status: 'CLOSED' as const })

  if (!canTransition(event.status, 'CLOSED')) {
    return fail('ILLEGAL_TRANSITION', 'Only a published event can be closed.')
  }

  return runCommand({
    name: 'closeEvent',
    input,
    ctx,
    eventId: event.id,
    execute: async (tx) => {
      await tx.daaliEvent.update({ where: { id: event.id }, data: { status: 'CLOSED' } })
      return ok({ eventId: event.id, status: 'CLOSED' as const })
    },
  })
}
