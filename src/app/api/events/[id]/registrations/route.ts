import { prisma } from '@/lib/prisma'
import { registerForEvent } from '@/commands/registrations'
import { getOrCreateAccessToken } from '@/lib/accessToken'
import { deliverNotification } from '@/notifications/deliver'
import { toResponse, idempotencyKeyFrom } from '@/lib/httpResult'
import { NextResponse } from 'next/server'

/** Public RSVP. No session required — identity is the email. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()

  const result = await registerForEvent(
    {
      eventId: id,
      name: String(body.name ?? ''),
      email: String(body.email ?? ''),
      phone: body.phone ?? null,
      partySize: Number(body.partySize ?? 1),
      note: body.note ?? null,
    },
    { actor: { kind: 'HUMAN' }, idempotencyKey: idempotencyKeyFrom(req) },
  )

  if (!result.ok) return toResponse(result)

  // The token is derived AFTER the command, so it never lands in
  // CommandExecution.result. See registerForEvent for why.
  const token = await prisma.$transaction((tx) => getOrCreateAccessToken(tx, result.data.eventPersonId))

  // AFTER COMMIT. deliverNotification never throws and only ever writes to
  // NotificationDelivery, so a dead mail provider cannot touch this RSVP.
  //
  // Awaited rather than fire-and-forget: on Vercel, work started after the
  // response is not guaranteed to run. The send carries a 4s timeout, and a
  // timeout simply leaves the row `pending` for the organizer to resend.
  // (On Next 15 this is a good candidate for `after()` instead.)
  if (result.data.deliveryId) await deliverNotification(result.data.deliveryId)

  return NextResponse.json({ ...result.data, manageUrl: `/e/${body.slug}/rsvp/${token}` }, { status: 201 })
}
