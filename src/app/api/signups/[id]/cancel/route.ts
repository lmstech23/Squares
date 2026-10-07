import { prisma } from '@/lib/prisma'
import { cancelClaim } from '@/commands/signups'
import { hashToken } from '@/lib/accessToken'
import { humanOrganizerActor } from '@/lib/currentOrganizer'
import { toResponse, idempotencyKeyFrom } from '@/lib/httpResult'
import type { ActorContext } from '@/lib/commands/types'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))

  let actor: ActorContext | null = null
  if (body.token) {
    const row = await prisma.daaliEventPersonAccessToken.findUnique({
      where: { tokenHash: hashToken(String(body.token)) },
      select: { eventPersonId: true, revokedAt: true },
    })
    if (row && !row.revokedAt) actor = { kind: 'HUMAN', eventPersonId: row.eventPersonId }
  }
  if (!actor) actor = await humanOrganizerActor()
  if (!actor) return toResponse({ ok: false, code: 'FORBIDDEN', message: 'You cannot change this sign-up.' })

  const result = await cancelClaim(
    { helperSignupId: id, quantity: body.quantity ? Number(body.quantity) : undefined },
    { actor, idempotencyKey: idempotencyKeyFrom(req) },
  )
  return toResponse(result)
}
