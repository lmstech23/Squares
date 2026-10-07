import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isMutable, immutableReason, type EventState } from './eventCore.ts'
import { seatsRemaining } from '../db/capacity.ts'

const draft: EventState = { status: 'DRAFT', publishedAt: null, registrationCount: 0 }
const live: EventState = { status: 'PUBLISHED', publishedAt: new Date(), registrationCount: 0 }
const attended: EventState = { status: 'PUBLISHED', publishedAt: new Date(), registrationCount: 3 }

describe('capability contract — the organizer form reads these', () => {
  it('slug is editable in draft and frozen once the link is out', () => {
    assert.equal(isMutable('slug', draft), true)
    assert.equal(isMutable('slug', live), false)
    assert.match(immutableReason('slug', live) as string, /link/i)
  })

  it('timezone freezes only once someone has RSVPed, not merely on publish', () => {
    assert.equal(isMutable('timezone', live), true)
    assert.equal(isMutable('timezone', attended), false)
    assert.match(immutableReason('timezone', attended) as string, /already RSVPed/i)
  })

  it('capacity stays field-mutable — the floor is a command rule, not a field rule', () => {
    assert.equal(isMutable('capacity', attended), true)
    assert.equal(immutableReason('capacity', attended), null)
  })

  it('an unknown field is never writable by default', () => {
    assert.equal(isMutable('organizerUserId', draft), false)
    assert.equal(isMutable('status', draft), false)
  })
})

describe('seat arithmetic', () => {
  it('uncapped events report null rather than a number', () => {
    assert.equal(seatsRemaining(null, 40), null)
  })
  it('never reports negative remaining', () => {
    assert.equal(seatsRemaining(10, 12), 0)
    assert.equal(seatsRemaining(10, 4), 6)
    assert.equal(seatsRemaining(10, 10), 0)
  })
})
