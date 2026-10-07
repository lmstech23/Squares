import { prisma } from '@/lib/prisma'
import { cancelRegistration } from '@/commands/registrations'
import { hashToken } from '@/lib/accessToken'
import { humanOrganizerActor } from '@/lib/commands/organizerActor'
import { toResponse, idempotencyKeyFrom } from '@/lib/httpResult'
import type { ActorContext } from '@/lib/commands/types'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))

  let actor: ActorContext | null = null

  // Participant path: prove identity with the emailed token.
  if (body.token) {
    const row = await prisma.daaliEventPersonAccessToken.findUnique({
      where: { tokenHash: hashToken(String(body.token)) },
      select: { eventPersonId: true, revokedAt: true },
    })
    if (row && !row.revokedAt) actor = { kind: 'HUMAN', eventPersonId: row.eventPersonId }
  }

  // Organizer path.
  if (!actor) actor = await humanOrganizerActor()

  if (!actor) {
    return toResponse({ ok: false, code: 'FORBIDDEN', message: 'You cannot change this RSVP.' })
  }

  const result = await cancelRegistration({ registrationId: id }, { actor, idempotencyKey: idempotencyKeyFrom(req) })
  return toResponse(result)
}
