import { notFound } from 'next/navigation'
import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { currentOrganizerUserId } from '@/lib/currentOrganizer'
import SlotManager from './SlotManager'
import s from '../../events.module.css'

export const dynamic = 'force-dynamic'

export default async function SignupsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const userId = await currentOrganizerUserId()
  if (!userId) return <main className={s.page}><p>Sign in to continue.</p></main>

  const event = await prisma.event.findUnique({
    where: { id },
    select: { id: true, title: true, timezone: true, organizerUserId: true },
  })
  if (!event || event.organizerUserId !== userId) notFound()

  const sheet = await prisma.signupSheet.findUnique({
    where: { eventId: event.id },
    select: {
      isOpen: true,
      slots: {
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true, slotType: true, name: true, capacity: true, unitLabel: true,
          startsAt: true, endsAt: true,
          signups: {
            select: {
              id: true, note: true, actorKind: true,
              person: { select: { name: true, email: true } },
              _count: { select: { positions: true } },
            },
          },
        },
      },
    },
  })

  return (
    <main className={s.page}>
      <h1 className={s.h1}>{event.title}</h1>
      <p className={s.sub}>Volunteers and items</p>

      <div className={s.actions} style={{ marginTop: 0, marginBottom: 26 }}>
        <Link className={`${s.btn} ${s.ghost}`} href={`/events/${event.id}/edit`}>Back to event</Link>
        <Link className={`${s.btn} ${s.ghost}`} href={`/events/${event.id}/registrations`}>RSVPs</Link>
      </div>

      <SlotManager eventId={event.id} isOpen={sheet?.isOpen ?? true} />

      {(sheet?.slots ?? []).map((slot) => {
        const taken = slot.signups.reduce((n, sg) => n + sg._count.positions, 0)
        return (
          <div key={slot.id} className={s.card} style={{ marginBottom: 14 }}>
            <div className={s.row}>
              <div>
                <div className={s.title}>{slot.name}</div>
                <div className={s.meta}>
                  {slot.slotType === 'SHIFT' && slot.startsAt
                    ? new Intl.DateTimeFormat('en-US', {
                        weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: event.timezone,
                      }).format(slot.startsAt)
                    : slot.unitLabel ?? slot.slotType}
                </div>
              </div>
              <span className={`${s.badge} ${taken >= slot.capacity ? s.published : s.draft}`}>
                {taken} / {slot.capacity}
              </span>
            </div>

            {slot.signups.length === 0 && (
              <div className={s.meta} style={{ paddingTop: 12 }}>Nobody yet.</div>
            )}

            {slot.signups.map((sg) => (
              <div key={sg.id} className={s.row}>
                <div>
                  <div className={s.title} style={{ fontWeight: 500 }}>{sg.person.name}</div>
                  <div className={s.meta}>
                    {sg.person.email}
                    {sg.note ? ` · "${sg.note}"` : ''}
                    {sg.actorKind === 'AGENT' ? ' · added by Daali' : ''}
                  </div>
                </div>
                <span className={s.meta}>
                  {/* quantity is count(positions) — never a stored column */}
                  {sg._count.positions}
                  {slot.slotType === 'ITEM' ? ` ${slot.unitLabel ?? ''}` : ''}
                </span>
              </div>
            ))}
          </div>
        )
      })}
    </main>
  )
}
