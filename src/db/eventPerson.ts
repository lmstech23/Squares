import type { Prisma } from '@prisma/client'
import { resolveIdentityKey } from '@/domain/identity'

/**
 * The only function that creates an EventPerson.
 *
 * Runs INSIDE the caller's transaction. Never a standalone write.
 *
 * SCOPE DISCIPLINE [R5]: this is the only place that knows a person is scoped to
 * an event. Everything downstream takes `eventPersonId` and never reconstructs
 * identity from `eventId + email`. When a standalone fundraiser needs
 * participants, re-scoping is a change to this signature and one unique index —
 * not a hunt through the signup and notification domains.
 */
export async function resolveEventPerson(
  tx: Prisma.TransactionClient,
  eventId: string,
  input: { name: string; email: string; phone?: string | null },
) {
  const identityKey = resolveIdentityKey(input.email)
  const name = input.name.trim()
  const email = input.email.trim()
  const phone = input.phone?.trim() || null

  return tx.daaliEventPerson.upsert({
    where: { eventId_identityKey: { eventId, identityKey } },
    create: { eventId, identityKey, name, email, phone },
    update: {
      // Only non-empty incoming values win. A parent who RSVPs as "Dee" and later
      // signs up as "Daaliyah Coleman" ends up with the better name and one row.
      //
      // [R2] This is safe ONLY because slice 1 has no surface on which an
      // organizer can edit a name — every write comes from the person themselves,
      // so a later write is a correction, not a loss. When organizer name editing
      // lands, it lands WITH `nameSetByOrganizerAt`, checked here before
      // overwriting. Not before: a provenance column with no second writer
      // records nothing.
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
    },
  })
}
