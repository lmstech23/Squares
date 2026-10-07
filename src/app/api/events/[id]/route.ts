import { updateEvent } from '@/commands/events'
import { humanOrganizerActor } from '@/lib/currentOrganizer'
import { toResponse, unauthenticated, idempotencyKeyFrom } from '@/lib/httpResult'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await humanOrganizerActor()
  if (!actor) return unauthenticated()

  const { id } = await params
  const body = await req.json()

  const patch: Record<string, unknown> = {}
  if ('title' in body) patch.title = String(body.title)
  if ('description' in body) patch.description = body.description ?? null
  if ('startsAt' in body) patch.startsAt = new Date(body.startsAt)
  if ('endsAt' in body) patch.endsAt = body.endsAt ? new Date(body.endsAt) : null
  if ('timezone' in body) patch.timezone = String(body.timezone)
  if ('venueName' in body) patch.venueName = body.venueName ?? null
  if ('venueAddress' in body) patch.venueAddress = body.venueAddress ?? null
  if ('capacity' in body) patch.capacity = body.capacity === '' || body.capacity == null ? null : Number(body.capacity)

  const result = await updateEvent(
    { eventId: id, patch },
    { actor, idempotencyKey: idempotencyKeyFrom(req) },
  )

  return toResponse(result)
}
