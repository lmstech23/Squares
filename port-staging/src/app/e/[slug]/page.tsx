import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { prisma } from '@/lib/prisma'
import { isPubliclyVisible, publicStateCopy, acceptsRegistrations } from '@/domain/eventStatus'
import RsvpForm from './RsvpForm'
import SignupSheetSection, { type PublicSlot } from './SignupSheet'
import s from './public.module.css'

export const dynamic = 'force-dynamic'

async function load(slug: string) {
  return prisma.event.findUnique({
    where: { slug },
    select: {
      id: true, title: true, description: true, startsAt: true, endsAt: true, timezone: true,
      venueName: true, venueAddress: true, status: true, capacity: true,
    },
  })
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const event = await load(slug)
  if (!event || !isPubliclyVisible(event.status)) return { title: 'Event not found' }
  return { title: event.title, description: event.description ?? undefined }
}

export default async function PublicEventPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const event = await load(slug)

  // Allowlist, never `status !== 'PUBLISHED'`. [R1]
  if (!event || !isPubliclyVisible(event.status)) notFound()

  const copy = publicStateCopy(event.status)

  // Seats remaining is DERIVED here too. Nothing stores it.
  const agg = await prisma.registration.aggregate({
    where: { eventId: event.id, status: 'CONFIRMED' },
    _sum: { partySize: true },
  })
  const seatsRemaining =
    event.capacity === null ? null : Math.max(0, event.capacity - (agg._sum.partySize ?? 0))

  // Sign-ups are INDEPENDENT of RSVP. A person who cannot attend but is dropping
  // off two cases of water never touches the form above.
  const sheet = await prisma.signupSheet.findUnique({
    where: { eventId: event.id },
    select: {
      title: true, instructions: true, isOpen: true,
      slots: {
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true, slotType: true, name: true, notes: true, unitLabel: true,
          capacity: true, startsAt: true, endsAt: true,
          _count: { select: { positions: true } },
        },
      },
    },
  })

  const slots: PublicSlot[] = (sheet?.slots ?? []).map((slot) => ({
    id: slot.id,
    slotType: slot.slotType,
    name: slot.name,
    notes: slot.notes,
    unitLabel: slot.unitLabel,
    when: slot.startsAt
      ? new Intl.DateTimeFormat('en-US', {
          weekday: 'short', hour: 'numeric', minute: '2-digit',
          timeZone: event.timezone,
        }).format(slot.startsAt)
      : null,
    capacity: slot.capacity,
    // Quantity taken is DERIVED from position rows. Nothing stores it.
    taken: slot._count.positions,
  }))
  const when = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: event.timezone, timeZoneName: 'short',
  }).format(event.startsAt)

  return (
    <main className={s.page}>
      <article className={s.card}>
        {copy.headline && <div className={s.notice}>{copy.headline}</div>}

        <h1 className={s.title}>{event.title}</h1>
        <p className={s.when}>{when}</p>

        {(event.venueName || event.venueAddress) && (
          <p className={s.venue}>
            {event.venueName}
            {event.venueName && event.venueAddress ? ' · ' : ''}
            {event.venueAddress}
          </p>
        )}

        {event.description && <p className={s.body}>{event.description}</p>}

        {acceptsRegistrations(event.status) && (
          <RsvpForm eventId={event.id} slug={slug} seatsRemaining={seatsRemaining} />
        )}

        {sheet?.isOpen && slots.length > 0 && (
          <SignupSheetSection
            slug={slug}
            title={sheet.title ?? 'Ways to help'}
            instructions={sheet.instructions}
            slots={slots}
          />
        )}
      </article>
    </main>
  )
}
