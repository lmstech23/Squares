import { createEvent } from '@/commands/events'
import { humanOrganizerActor } from '@/lib/commands/organizerActor'
import { toResponse, unauthenticated, idempotencyKeyFrom } from '@/lib/httpResult'

export async function POST(req: Request) {
  const actor = await humanOrganizerActor()
  if (!actor) return unauthenticated()

  const body = await req.json()

  const result = await createEvent(
    {
      title: String(body.title ?? ''),
      startsAt: new Date(body.startsAt),
      endsAt: body.endsAt ? new Date(body.endsAt) : null,
      timezone: String(body.timezone ?? ''),
      description: body.description ?? null,
      venueName: body.venueName ?? null,
      venueAddress: body.venueAddress ?? null,
      capacity: body.capacity == null || body.capacity === '' ? null : Number(body.capacity),
    },
    { actor, idempotencyKey: idempotencyKeyFrom(req) },
  )

  return toResponse(result, 201)
}
