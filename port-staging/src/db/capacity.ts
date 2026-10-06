import type { Prisma } from '@prisma/client'

/**
 * Capacity is measured in SEATS and DERIVED. There is no stored counter anywhere,
 * so there is nothing that can drift out of sync with the registrations.
 *
 * Proven under load: tests/concurrency.mjs — 20 concurrent RSVPs against 10 seats
 * confirms exactly 10.
 */

export type LockedEvent = { id: string; status: 'DRAFT' | 'PUBLISHED' | 'CLOSED'; capacity: number | null }

/**
 * Lock the event row FIRST. Every writer that can change seat occupancy takes
 * this lock, which is what serializes them. At community-event scale this is
 * free; it stops being free at a ticket on-sale with thousands of simultaneous
 * buyers, and THAT is the moment to revisit — with load evidence, in the phase
 * that introduces it.
 */
export async function lockEventForSeating(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<LockedEvent | null> {
  const rows = await tx.$queryRaw<LockedEvent[]>`
    SELECT "id", "status", "capacity" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE
  `
  return rows[0] ?? null
}

export async function seatsTaken(tx: Prisma.TransactionClient, eventId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ seats: number }[]>`
    SELECT COALESCE(SUM("partySize"), 0)::int AS seats
      FROM "Registration"
     WHERE "eventId" = ${eventId} AND "status" = 'CONFIRMED'
  `
  return Number(rows[0]?.seats ?? 0)
}

export function seatsRemaining(capacity: number | null, taken: number): number | null {
  return capacity === null ? null : Math.max(0, capacity - taken)
}
