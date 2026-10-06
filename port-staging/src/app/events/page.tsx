import Link from 'next/link'
import { assertNever } from '@/domain/assertNever'
import type { EventStatus } from '@/domain/eventStatus'
import { prisma } from '@/lib/prisma'
import { currentOrganizerUserId } from '@/lib/currentOrganizer'
import s from './events.module.css'

export const dynamic = 'force-dynamic'

/**
 * [R1] applies to my own code too. `s[status.toLowerCase()]` would silently
 * resolve to undefined when CANCELLED lands — a missing badge style, no error.
 * An exhaustive switch makes it a build failure instead.
 */
function badgeClass(status: EventStatus): string {
  switch (status) {
    case 'DRAFT':     return s.draft
    case 'PUBLISHED': return s.published
    case 'CLOSED':    return s.closed
    default: return assertNever(status)
  }
}

export default async function EventsPage() {
  const userId = await currentOrganizerUserId()
  if (!userId) return <main className={s.page}><p>Sign in to see your events.</p></main>

  const events = await prisma.event.findMany({
    where: { organizerUserId: userId },
    orderBy: [{ startsAt: 'desc' }],
    select: { id: true, title: true, slug: true, startsAt: true, timezone: true, status: true },
  })

  return (
    <main className={s.page}>
      <h1 className={s.h1}>Your events</h1>
      <p className={s.sub}>{events.length === 0 ? 'Nothing here yet.' : `${events.length} event${events.length === 1 ? '' : 's'}`}</p>

      <div className={s.actions} style={{ marginTop: 0, marginBottom: 28 }}>
        <Link className={`${s.btn} ${s.primary}`} href="/events/new">Create an event</Link>
      </div>

      {events.length > 0 && (
        <div className={s.card}>
          {events.map((e) => (
            <div key={e.id} className={s.row}>
              <div>
                <div className={s.title}>{e.title}</div>
                <div className={s.meta}>
                  {new Intl.DateTimeFormat('en-US', {
                    dateStyle: 'medium', timeStyle: 'short', timeZone: e.timezone,
                  }).format(e.startsAt)}
                  {e.slug ? ` · /e/${e.slug}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <span className={`${s.badge} ${badgeClass(e.status)}`}>{e.status}</span>
                <Link className={`${s.btn} ${s.ghost}`} href={`/events/${e.id}/edit`}>Edit</Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
