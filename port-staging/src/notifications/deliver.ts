import { prisma } from '@/lib/prisma'
import { emailProvider } from './providers'
import { renderRsvpConfirmation } from './templates/rsvpConfirmation'
import { getOrCreateAccessToken } from '@/lib/accessToken'
import { assertNever } from '@/domain/assertNever'
import { resolveAppUrl } from '@/lib/appUrl'
import type { NotificationType } from './types'

const SEND_TIMEOUT_MS = 4000

/**
 * ⚠️ THE INVARIANT OF THIS PHASE:
 *   A FAILED EMAIL MUST NEVER ROLL BACK OR INVALIDATE THE RSVP.
 *
 * Structurally guaranteed, not merely intended:
 *
 *   1. This function runs AFTER the RSVP transaction has committed. It is never
 *      called from inside runCommand.
 *   2. It never throws. Every path returns; the catch-all marks the row failed.
 *   3. It writes only to NotificationDelivery. It cannot touch Registration.
 *
 * 0D.0 has no lease, no fencing token, no cron. A send that fails leaves a
 * visible `failed` row with the error, and the organizer resends by hand. That
 * failure mode is bounded and honest. 0D.1 automates the recovery.
 */
export async function deliverNotification(deliveryId: string): Promise<void> {
  try {
    const delivery = await prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      select: {
        id: true, notificationType: true, dedupeKey: true, status: true,
        eventPersonId: true, registrationId: true,
      },
    })

    // "Has this been sent," never "has this payment been processed." Gating on
    // the upstream operation is how a permanently failed email becomes invisible.
    if (!delivery || delivery.status === 'sent') return

    const built = await buildEmail(
      delivery.notificationType, delivery.registrationId, delivery.eventPersonId, delivery.dedupeKey,
    )

    // A message we cannot build correctly is never sent. A broken manage link is
    // worse than a visible failure: the guest gets mail that does not work and
    // nobody finds out.
    if (!built.ok) {
      await settle(deliveryId, { ok: false, error: built.error })
      return
    }
    const email = built.email

    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: { attempts: { increment: 1 } },
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
    try {
      const outcome = await emailProvider().send(email, controller.signal)
      await settle(deliveryId, outcome)
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    // Nothing in here may escape into the caller's request.
    await settle(deliveryId, { ok: false, error: e instanceof Error ? e.message : String(e) })
      .catch(() => {})
  }
}

async function settle(
  id: string,
  outcome: { ok: true; providerMessageId: string | null } | { ok: false; error: string },
) {
  await prisma.notificationDelivery.update({
    where: { id },
    data: outcome.ok
      ? { status: 'sent', sentAt: new Date(), providerMessageId: outcome.providerMessageId, lastError: null }
      : { status: 'failed', lastError: outcome.error.slice(0, 1000) },
  })
}

type BuildResult =
  | { ok: true; email: { to: string; subject: string; text: string; html: string; idempotencyKey: string } }
  | { ok: false; error: string }

async function buildEmail(
  type: NotificationType,
  registrationId: string | null,
  eventPersonId: string,
  dedupeKey: string,
): Promise<BuildResult> {
  switch (type) {
    case 'RSVP_CONFIRMED': {
      if (!registrationId) return { ok: false, error: 'Delivery has no registration to confirm.' }

      // Checked BEFORE any database or provider work. A misconfigured origin is
      // the same failure for every delivery, so fail it early and identically.
      const appUrl = resolveAppUrl()
      if (!appUrl.ok) return { ok: false, error: appUrl.error }
      const reg = await prisma.registration.findUnique({
        where: { id: registrationId },
        select: {
          partySize: true, status: true,
          person: { select: { id: true, name: true, email: true } },
          event: { select: { title: true, slug: true, startsAt: true, timezone: true, venueName: true, venueAddress: true } },
        },
      })
      if (!reg) return { ok: false, error: 'Registration no longer exists.' }
      if (reg.status !== 'CONFIRMED') return { ok: false, error: 'Registration is no longer confirmed.' }
      if (!reg.event.slug) return { ok: false, error: 'Event has no public link yet.' }

      // The token is DERIVED at send time, which is why it never had to be
      // carried through the command result or stored on the delivery row.
      const token = await prisma.$transaction((tx) => getOrCreateAccessToken(tx, reg.person.id))

      const body = renderRsvpConfirmation({
        personName: reg.person.name,
        eventTitle: reg.event.title,
        when: new Intl.DateTimeFormat('en-US', {
          weekday: 'long', month: 'long', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
          timeZone: reg.event.timezone, timeZoneName: 'short',
        }).format(reg.event.startsAt),
        venue: [reg.event.venueName, reg.event.venueAddress].filter(Boolean).join(' · ') || null,
        partySize: reg.partySize,
        manageUrl: `${appUrl.origin}/e/${reg.event.slug}/rsvp/${token}`,
      })

      return { ok: true, email: { to: reg.person.email, ...body, idempotencyKey: `${type}:${dedupeKey}` } }
    }
    default:
      return assertNever(type)
  }
}
