import { runCommand } from '@/lib/commands/runCommand'
import { actorStamp } from '@/lib/commands/authorize'
import { fail, ok, type Command } from '@/lib/commands/types'
import { acceptsRegistrations } from '@/domain/eventStatus'
import { isPlausibleEmail } from '@/domain/identity'
import { resolveEventPerson } from '@/db/eventPerson'
import { lockEventForSeating, seatsTaken, seatsRemaining } from '@/db/capacity'
import { enqueueNotification } from '@/notifications/enqueue'

export type RegisterForEventInput = {
  eventId: string
  name: string
  email: string
  phone?: string | null
  partySize: number
  note?: string | null
}

export type RegisterForEventResult = {
  registrationId: string
  eventPersonId: string
  partySize: number
  seatsRemaining: number | null
  updated: boolean
  /** enqueued inside the transaction; delivered after commit by the route */
  deliveryId: string | null
}

const MAX_PARTY = 20

export const registerForEvent: Command<RegisterForEventInput, RegisterForEventResult> =
  async (input, ctx) => {
    if (!input.name?.trim()) return fail('VALIDATION_FAILED', 'Please add your name.', [{ field: 'name', message: 'Required.' }])
    if (!isPlausibleEmail(input.email ?? '')) return fail('VALIDATION_FAILED', 'Please add a valid email.', [{ field: 'email', message: 'Required.' }])
    if (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > MAX_PARTY) {
      return fail('VALIDATION_FAILED', `Party size must be between 1 and ${MAX_PARTY}.`, [{ field: 'partySize', message: 'Invalid.' }])
    }

    return runCommand({
      name: 'registerForEvent',
      input,
      ctx,
      eventId: input.eventId,
      execute: async (tx) => {
        // Lock first. Everything below is serialized per event.
        const event = await lockEventForSeating(tx, input.eventId)
        if (!event) return fail<RegisterForEventResult>('NOT_FOUND', 'That event no longer exists.')

        // Allowlist, never `status !== 'PUBLISHED'`. [R1]
        if (!acceptsRegistrations(event.status)) {
          return fail<RegisterForEventResult>('CONFLICT', 'This event is not accepting RSVPs.')
        }

        const person = await resolveEventPerson(tx, event.id, input)

        // The partial unique index permits exactly one live registration, so an
        // existing one is a CHANGE of party size, not a second RSVP.
        const existing = await tx.registration.findFirst({
          where: { eventId: event.id, eventPersonId: person.id, status: 'CONFIRMED' },
          select: { id: true, partySize: true },
        })

        const delta = input.partySize - (existing?.partySize ?? 0)
        const taken = await seatsTaken(tx, event.id)

        // All or nothing. Never silently admit fewer than they asked for — an
        // organizer reading "party of 4" who gets 2 has a real problem at 8am.
        if (event.capacity !== null && taken + delta > event.capacity) {
          return fail<RegisterForEventResult>(
            'CONFLICT',
            'There are not enough seats left for that party size.',
            { seatsRemaining: seatsRemaining(event.capacity, taken) },
          )
        }

        const stamp = actorStamp(ctx.actor)

        const row = existing
          ? await tx.registration.update({
              where: { id: existing.id },
              data: { partySize: input.partySize, note: input.note?.trim() || null },
              select: { id: true },
            })
          : await tx.registration.create({
              data: {
                eventId: event.id,
                eventPersonId: person.id,
                partySize: input.partySize,
                note: input.note?.trim() || null,
                status: 'CONFIRMED',
                actorKind: stamp.actorKind,
                actorUserId: stamp.actorUserId,
                actorEventPersonId: stamp.actorEventPersonId ?? person.id,
                planExecutionId: stamp.planExecutionId,
              },
              select: { id: true },
            })

        // [0C follow-up] Who changed this RSVP from 2 to 6? The row is updated
        // in place, so without this the later actor was lost — a real gap once
        // both HUMAN and AGENT drive the same command.
        if (!existing || existing.partySize !== input.partySize) {
          await tx.registrationLog.create({
            data: {
              registrationId: row.id,
              eventId: event.id,
              eventPersonId: person.id,
              action: existing ? 'PARTY_SIZE_CHANGED' : 'CREATED',
              fromPartySize: existing?.partySize ?? null,
              toPartySize: input.partySize,
              ...stamp,
              actorEventPersonId: stamp.actorEventPersonId ?? person.id,
            },
          })
        }

        // ENQUEUE JOINS THIS TRANSACTION — it is a local insert with no network
        // call. The SEND happens after commit and can never roll this back.
        const deliveryId = existing
          ? null   // a party-size change is not a new confirmation
          : await enqueueNotification(tx, {
              notificationType: 'RSVP_CONFIRMED',
              eventPersonId: person.id,
              registrationId: row.id,
              subjectId: row.id,
            })

        // NOTE: the access token is deliberately NOT in this result. The result is
        // persisted verbatim in CommandExecution.result for replay [R4], and a
        // magic link does not belong in a durable row. The route derives it after
        // success from eventPersonId.
        return ok({
          registrationId: row.id,
          eventPersonId: person.id,
          partySize: input.partySize,
          seatsRemaining: seatsRemaining(event.capacity, taken + delta),
          updated: Boolean(existing),
          deliveryId,
        })
      },
    })
  }
