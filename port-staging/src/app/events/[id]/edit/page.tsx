import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { currentOrganizerUserId } from '@/lib/currentOrganizer'
import { eventCore, immutableReason } from '@/capabilities/eventCore'
import EventForm from '../../EventForm'
import s from '../../events.module.css'

export const dynamic = 'force-dynamic'

/** datetime-local wants "YYYY-MM-DDTHH:mm" in the event's own zone. */
function localInput(d: Date | null, tz: string): string {
  if (!d) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((a, p) => (a[p.type] = p.value, a), {})
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

export default async function EditEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const userId = await currentOrganizerUserId()
  if (!userId) return <main className={s.page}><p>Sign in to continue.</p></main>

  const event = await prisma.event.findUnique({ where: { id } })
  if (!event || event.organizerUserId !== userId) notFound()

  // 0B: EventState gained registrationCount, so every caller had to supply it.
  const registrationCount = await prisma.registration.count({
    where: { eventId: event.id, status: 'CONFIRMED' },
  })

  // THE CAPABILITY CONTRACT'S PRESENT-DAY CONSUMER.
  // The form disables what the contract says can no longer change, and shows the
  // reason string — the same string Daali will say out loud later.
  const state = { status: event.status, publishedAt: event.publishedAt, registrationCount }
  const locked: Record<string, string> = {}
  for (const f of Object.keys(eventCore.mutability)) {
    const reason = immutableReason(f, state)
    if (reason) locked[f] = reason
  }

  return (
    <main className={s.page}>
      <h1 className={s.h1}>{event.title}</h1>
      <p className={s.sub}>
        {event.status}
        {event.slug ? ` · /e/${event.slug}` : ' · no public link until published'}
      </p>

      {registrationCount > 0 && (
        <p className={s.sub}>
          <a href={`/events/${event.id}/registrations`}>
            {registrationCount} RSVP{registrationCount === 1 ? '' : 's'} — view roster
          </a>
        </p>
      )}

      <p className={s.sub}>
        <a href={`/events/${event.id}/signups`}>Volunteers &amp; items</a>
      </p>

      <EventForm
        mode="edit"
        eventId={event.id}
        status={event.status}
        slug={event.slug}
        locked={locked}
        initial={{
          title: event.title,
          description: event.description ?? '',
          startsAt: localInput(event.startsAt, event.timezone),
          endsAt: localInput(event.endsAt, event.timezone),
          timezone: event.timezone,
          capacity: event.capacity?.toString() ?? '',
          venueName: event.venueName ?? '',
          venueAddress: event.venueAddress ?? '',
        }}
      />
    </main>
  )
}
