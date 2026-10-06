import type { Prisma } from '@prisma/client'
import type { NotificationType } from './types'

/**
 * Enqueue joins the caller's transaction. The SEND never does.
 *
 * Inserting the row is a local write with no network call, so putting it in the
 * transaction costs nothing and removes the window where an RSVP commits with
 * nothing queued behind it.
 */
export function dedupeKeyFor(type: NotificationType, subjectId: string): string {
  switch (type) {
    // A receipt belongs to a registration, the way a receipt belongs to a
    // purchase. Someone who RSVPs, cancels, and RSVPs again deserves the second
    // confirmation — a person-scoped key would silently suppress it.
    case 'RSVP_CONFIRMED': return `registration:${subjectId}`
  }
}

export async function enqueueNotification(
  tx: Prisma.TransactionClient,
  args: {
    notificationType: NotificationType
    eventPersonId: string
    registrationId?: string | null
    subjectId: string
  },
): Promise<string | null> {
  const dedupeKey = dedupeKeyFor(args.notificationType, args.subjectId)

  // ON CONFLICT DO NOTHING. A duplicate enqueue is not an error — it means this
  // thing already has a delivery record, which is exactly what we wanted.
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "NotificationDelivery"
      ("id", "notificationType", "dedupeKey", "eventPersonId", "registrationId", "status", "updatedAt")
    VALUES (gen_random_uuid()::text, ${args.notificationType}::"NotificationType", ${dedupeKey},
            ${args.eventPersonId}, ${args.registrationId ?? null}, 'pending', now())
    ON CONFLICT ("notificationType", "dedupeKey") DO NOTHING
    RETURNING "id"
  `
  return rows[0]?.id ?? null
}
