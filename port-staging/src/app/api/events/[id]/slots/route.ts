import { addSlot, setSheetOpen } from '@/commands/signups'
import { humanOrganizerActor } from '@/lib/currentOrganizer'
import { toResponse, unauthenticated, idempotencyKeyFrom } from '@/lib/httpResult'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await humanOrganizerActor()
  if (!actor) return unauthenticated()

  const { id } = await params
  const body = await req.json()
  const ctx = { actor, idempotencyKey: idempotencyKeyFrom(req) }

  if (body.action === 'setOpen') {
    return toResponse(await setSheetOpen({ eventId: id, isOpen: Boolean(body.isOpen) }, ctx))
  }

  const slotType = body.slotType === 'ITEM' ? 'ITEM' as const : 'SHIFT' as const
  return toResponse(
    await addSlot(
      {
        eventId: id,
        slotType,
        name: String(body.name ?? ''),
        capacity: Number(body.capacity ?? 1),
        startsAt: body.startsAt ? new Date(body.startsAt) : null,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        unitLabel: body.unitLabel ?? null,
        notes: body.notes ?? null,
      },
      ctx,
    ),
    201,
  )
}
