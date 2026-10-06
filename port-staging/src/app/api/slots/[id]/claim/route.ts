import { prisma } from '@/lib/prisma'
import { claimSlot } from '@/commands/signups'
import { getOrCreateAccessToken } from '@/lib/accessToken'
import { toResponse, idempotencyKeyFrom } from '@/lib/httpResult'
import { NextResponse } from 'next/server'

/** Public. No RSVP required, no session required. Identity is the email. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()

  const result = await claimSlot(
    {
      slotId: id,
      name: String(body.name ?? ''),
      email: String(body.email ?? ''),
      phone: body.phone ?? null,
      quantity: Number(body.quantity ?? 1),
      note: body.note ?? null,
    },
    { actor: { kind: 'HUMAN' }, idempotencyKey: idempotencyKeyFrom(req) },
  )

  if (!result.ok) return toResponse(result)

  const token = await prisma.$transaction((tx) => getOrCreateAccessToken(tx, result.data.eventPersonId))
  return NextResponse.json({ ...result.data, manageUrl: `/e/${body.slug}/rsvp/${token}` }, { status: 201 })
}
