import { prisma } from '@/lib/prisma'
import { deliverNotification } from '@/notifications/deliver'
import { currentOrganizerUserId } from '@/lib/commands/organizerActor'
import { NextResponse } from 'next/server'
import { unauthenticated } from '@/lib/httpResult'

/** Manual resend. The whole recovery story in 0D.0 — 0D.1 automates it. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await currentOrganizerUserId()
  if (!userId) return unauthenticated()

  const { id } = await params
  const delivery = await prisma.daaliNotificationDelivery.findUnique({
    where: { id },
    select: { id: true, registration: { select: { event: { select: { organizerUserId: true } } } } },
  })
  if (!delivery) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  if (delivery.registration?.event.organizerUserId !== userId) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })
  }

  await deliverNotification(delivery.id)

  const after = await prisma.daaliNotificationDelivery.findUnique({
    where: { id }, select: { status: true, lastError: true, attempts: true },
  })
  return NextResponse.json(after)
}
