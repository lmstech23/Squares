import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { hashToken } from '@/lib/accessToken'
import ManageRsvp from './ManageRsvp'
import s from '../../public.module.css'

export const dynamic = 'force-dynamic'

/** No login, no password, no account. The emailed link IS the identity. */
export default async function ManageRsvpPage({
  params,
}: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params

  const row = await prisma.eventPersonAccessToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { revokedAt: true, person: { select: { id: true, name: true } } },
  })
  if (!row || row.revokedAt) notFound()

  const registration = await prisma.registration.findFirst({
    where: { eventPersonId: row.person.id, status: 'CONFIRMED', event: { slug } },
    select: {
      id: true, partySize: true,
      event: { select: { title: true, startsAt: true, timezone: true } },
    },
  })

  return (
    <main className={s.page}>
      <article className={s.card}>
        <h1 className={s.title}>{registration?.event.title ?? 'Your RSVP'}</h1>

        {!registration ? (
          <p className={s.soon}>You don&rsquo;t have an active RSVP for this event.</p>
        ) : (
          <>
            <p className={s.when}>
              {new Intl.DateTimeFormat('en-US', {
                weekday: 'long', month: 'long', day: 'numeric',
                hour: 'numeric', minute: '2-digit',
                timeZone: registration.event.timezone, timeZoneName: 'short',
              }).format(registration.event.startsAt)}
            </p>
            <p className={s.venue}>
              {row.person.name} · {registration.partySize} seat
              {registration.partySize === 1 ? '' : 's'}
            </p>
            <ManageRsvp registrationId={registration.id} token={token} />
          </>
        )}
      </article>
    </main>
  )
}
