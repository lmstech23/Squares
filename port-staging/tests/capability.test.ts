import { describe, it, expect } from 'vitest'
import { isMutable, immutableReason, type EventState } from '../src/capabilities/eventCore'
import { seatsRemaining } from '../src/db/capacity'

const draft: EventState = { status: 'DRAFT', publishedAt: null, registrationCount: 0 }
const live: EventState = { status: 'PUBLISHED', publishedAt: new Date(), registrationCount: 0 }
const attended: EventState = { status: 'PUBLISHED', publishedAt: new Date(), registrationCount: 3 }

describe('capability contract — the organizer form reads these', () => {
  it('slug is editable in draft and frozen once the link is out', () => {
    expect(isMutable('slug', draft)).toBe(true)
    expect(isMutable('slug', live)).toBe(false)
    expect(immutableReason('slug', live)).toMatch(/link/i)
  })

  it('timezone freezes only once someone has RSVPed, not merely on publish', () => {
    expect(isMutable('timezone', live)).toBe(true)
    expect(isMutable('timezone', attended)).toBe(false)
    expect(immutableReason('timezone', attended)).toMatch(/already RSVPed/i)
  })

  it('capacity stays field-mutable — the floor is a command rule, not a field rule', () => {
    expect(isMutable('capacity', attended)).toBe(true)
    expect(immutableReason('capacity', attended)).toBeNull()
  })

  it('an unknown field is never writable by default', () => {
    expect(isMutable('organizerUserId', draft)).toBe(false)
    expect(isMutable('status', draft)).toBe(false)
  })
})

describe('seat arithmetic', () => {
  it('uncapped events report null rather than a number', () => {
    expect(seatsRemaining(null, 40)).toBeNull()
  })
  it('never reports negative remaining', () => {
    expect(seatsRemaining(10, 12)).toBe(0)
    expect(seatsRemaining(10, 4)).toBe(6)
    expect(seatsRemaining(10, 10)).toBe(0)
  })
})
