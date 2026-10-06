import type { EventStatus } from '@/domain/eventStatus'

/**
 * The capability contract, with its mutability half. Built before Daali exists,
 * because it has a PRESENT-DAY CONSUMER: the organizer edit form reads it to
 * disable fields and show the reason. Every rule here is exercised by a human
 * before an agent ever reads one.
 */

/**
 * State the mutability rules are allowed to see.
 *
 * 0B added `registrationCount`. Adding it forced every caller to supply it, which
 * is the point — the timezone rule below could not be written until the state it
 * depends on was real.
 */
export type EventState = {
  status: EventStatus
  publishedAt: Date | null
  /** confirmed registrations. NOT seats — this is "has anyone RSVPed at all" */
  registrationCount: number
}

export type Mutability = {
  mutable: (s: EventState) => boolean
  /** Daali will say this out loud later. The edit form says it today. */
  reason: string
}

export type FieldSpec = { field: string; required: boolean }

export type CapabilityContract = {
  key: 'event.core'
  required: FieldSpec[]
  defaults: Record<string, unknown>
  mutability: Record<string, Mutability>
}

const always: Mutability = { mutable: () => true, reason: '' }

export const eventCore: CapabilityContract = {
  key: 'event.core',

  required: [
    { field: 'title', required: true },
    { field: 'startsAt', required: true },
    { field: 'timezone', required: true },
  ],

  defaults: {
    status: 'DRAFT',
    capacity: null,
  },

  mutability: {
    title: always,
    description: always,
    startsAt: always,
    endsAt: always,
    venueName: always,
    venueAddress: always,

    // Real today: the slug is the link people have already been sent.
    slug: {
      mutable: (s) => s.publishedAt === null,
      reason: 'This event is live and its link may already have been shared.',
    },

    // Mutable — but never below seatsTaken. That is a COMMAND-level rule, not a
    // field-level one (enforced in updateEvent). Field mutability answers "may
    // this change"; the command still answers "is this new value legal".
    // Do not collapse the two.
    capacity: always,

    // 0B: people have now committed to a wall-clock time. Shifting the zone
    // under them silently moves the event on every calendar it was copied into.
    timezone: {
      mutable: (s) => s.registrationCount === 0,
      reason: 'People have already RSVPed to a time in this zone.',
    },
  },
}

export function isMutable(field: string, state: EventState): boolean {
  const rule = eventCore.mutability[field]
  return rule ? rule.mutable(state) : false
}

export function immutableReason(field: string, state: EventState): string | null {
  const rule = eventCore.mutability[field]
  if (!rule || rule.mutable(state)) return null
  return rule.reason
}
