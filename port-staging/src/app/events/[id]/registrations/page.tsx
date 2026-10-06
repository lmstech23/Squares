import { notFound } from 'next/navigation'
import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { currentOrganizerUserId } from '@/lib/currentOrganizer'
import DeliveryStatus from './DeliveryStatus'
import s from '../../events.module.css'

export const dynamic = 'force-dynamic'

export default async function RosterPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string }> }) {
  const { id } = await params
  const { q } = await searchParams
  const userId = await currentOrganizerUserId()
  if (!userId) return <main className={s.page}><p>Sign in to continue.</p></main>

  const event = await prisma.event.findUnique({
    where: { id },
    select: { id: true, title: true, capacity: true, organizerUserId: true },
  })
  if (!event || event.organizerUserId !== userId) notFound()

  const where = {
    eventId: event.id,
    status: 'CONFIRMED' as const,
    ...(q ? { person: { OR: [
      { name:  { contains: q, mode: 'insensitive' as const } },
      { email: { contains: q, mode: 'insensitive' as const } },
    ] } } : {}),
  }

  const [registrations, agg] = await Promise.all([
    prisma.registration.findMany({
      where, orderBy: { createdAt: 'desc' },
      select: {
        id: true, partySize: true, note: true, createdAt: true, actorKind: true,
        person: { select: { name: true, email: true, phone: true } },
        notifications: {
          where: { notificationType: 'RSVP_CONFIRMED' },
          select: { id: true, status: true, lastError: true },
          take: 1,
        },
      },
    }),
    prisma.registration.aggregate({
      where: { eventId: event.id, status: 'CONFIRMED' },
      _sum: { partySize: true }, _count: true,
    }),
  ])

  const taken = agg._sum.partySize ?? 0

  return (
    <main className={s.page}>
      <h1 className={s.h1}>{event.title}</h1>
      <p className={s.sub}>
        {agg._count} RSVP{agg._count === 1 ? '' : 's'} · {taken} seat{taken === 1 ? '' : 's'}
        {event.capacity !== null ? ` of ${event.capacity}` : ' · uncapped'}
      </p>

      <div className={s.actions} style={{ marginTop: 0, marginBottom: 24 }}>
        <Link className={`${s.btn} ${s.ghost}`} href={`/events/${event.id}/edit`}>Back to event</Link>
      </div>

      <form className={s.field} method="get">
        <input className={s.input} name="q" defaultValue={q ?? ''} placeholder="Search name or email" />
      </form>

      <div className={s.card}>
        {registrations.length === 0 && <p className={s.sub} style={{ margin: 0 }}>No RSVPs yet.</p>}
        {registrations.map((r) => (
          <div key={r.id} className={s.row}>
            <div>
              <div className={s.title}>{r.person.name}</div>
              <div className={s.meta}>
                {r.person.email}{r.person.phone ? ` · ${r.person.phone}` : ''}
                {r.note ? ` · "${r.note}"` : ''}
                {/* the actor stamp, surfaced: did the organizer do this, or Daali? */}
                {r.actorKind === 'AGENT' ? ' · added by Daali' : ''}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <DeliveryStatus
                deliveryId={r.notifications[0]?.id ?? null}
                status={r.notifications[0]?.status ?? null}
                lastError={r.notifications[0]?.lastError ?? null}
              />
              <span className={`${s.badge} ${s.closed}`}>
                {r.partySize} seat{r.partySize === 1 ? '' : 's'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </main>
  )
}
