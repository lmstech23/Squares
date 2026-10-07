import { closeEvent } from '@/commands/events'
import { humanOrganizerActor } from '@/lib/commands/organizerActor'
import { toResponse, unauthenticated, idempotencyKeyFrom } from '@/lib/httpResult'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await humanOrganizerActor()
  if (!actor) return unauthenticated()

  const { id } = await params
  const result = await closeEvent({ eventId: id }, { actor, idempotencyKey: idempotencyKeyFrom(req) })
  return toResponse(result)
}
