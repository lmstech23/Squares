import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isPubliclyVisible, acceptsRegistrations, canTransition, publicStateCopy } from './eventStatus.ts'
import { resolveIdentityKey, isPlausibleEmail } from './identity.ts'
import { slugifyTitle, candidateSlug } from './slug.ts'
import { validateEventDraft } from './eventValidation.ts'
import { canonicalize, hashInput } from '../lib/commands/canonical.ts'

describe('event status — allowlist behaviour [R1]', () => {
  it('drafts are not public', () => {
    assert.equal(isPubliclyVisible('DRAFT'), false)
    assert.equal(isPubliclyVisible('PUBLISHED'), true)
    assert.equal(isPubliclyVisible('CLOSED'), true)
  })

  it('closed keeps the URL alive but stops registration', () => {
    assert.equal(isPubliclyVisible('CLOSED'), true)
    assert.equal(acceptsRegistrations('CLOSED'), false)
  })

  it('closed has its own sentence, so CANCELLED can have a different one', () => {
    assert.equal(publicStateCopy('PUBLISHED').headline, null)
    assert.equal(publicStateCopy('CLOSED').headline, 'Registration is closed.')
  })

  it('transitions are one-way through the lifecycle', () => {
    assert.equal(canTransition('DRAFT', 'PUBLISHED'), true)
    assert.equal(canTransition('PUBLISHED', 'CLOSED'), true)
    assert.equal(canTransition('PUBLISHED', 'DRAFT'), false)
    assert.equal(canTransition('CLOSED', 'PUBLISHED'), false)
  })
})

describe('identity normalization', () => {
  it('collapses case and whitespace to one key', () => {
    assert.equal(resolveIdentityKey('Sarah@Example.com '), 'sarah@example.com')
    assert.equal(resolveIdentityKey('  SARAH@EXAMPLE.COM'), resolveIdentityKey('sarah@example.com'))
  })
  it('rejects obvious non-addresses', () => {
    assert.equal(isPlausibleEmail('sarah@example.com'), true)
    assert.equal(isPlausibleEmail('sarah'), false)
    assert.equal(isPlausibleEmail(''), false)
  })
})

describe('slug', () => {
  it('strips accents and punctuation', () => {
    assert.equal(slugifyTitle('Hampton Parent Tailgate 2026!'), 'hampton-parent-tailgate-2026')
    assert.equal(slugifyTitle('Café Night'), 'cafe-night')
  })
  it('never produces an empty or trailing-dash base', () => {
    assert.equal(slugifyTitle('!!!'), 'event')
    assert.equal(slugifyTitle('a'), 'event')
  })
  it('appends a suffix so two identical titles do not collide', () => {
    const a = candidateSlug('Spring Field Day')
    const b = candidateSlug('Spring Field Day')
    assert.notEqual(a, b)
    assert.equal(a.startsWith('spring-field-day-'), true)
  })
})

describe('validation', () => {
  it('rejects an end before the start', () => {
    const errs = validateEventDraft({
      title: 'Field Day', timezone: 'America/New_York',
      startsAt: new Date('2026-04-11T14:00:00Z'), endsAt: new Date('2026-04-11T13:00:00Z'),
    })
    assert.equal(errs.some((e) => e.field === 'endsAt'), true)
  })
  it('rejects a bogus timezone', () => {
    assert.equal(validateEventDraft({ timezone: 'Mars/Olympus' }).some((e) => e.field === 'timezone'), true)
    assert.deepEqual(validateEventDraft({ timezone: 'America/New_York' }), [])
  })
  it('rejects fractional or zero capacity', () => {
    assert.equal(validateEventDraft({ capacity: 0 }).length, 1)
    assert.equal(validateEventDraft({ capacity: 2.5 }).length, 1)
    assert.deepEqual(validateEventDraft({ capacity: null }), [])
  })
})

describe('canonical input hashing [R4]', () => {
  it('is stable across key order', () => {
    assert.equal(hashInput({ a: 1, b: 2 }), hashInput({ b: 2, a: 1 }))
  })
  it('treats undefined and absent as the same input', () => {
    assert.equal(hashInput({ a: 1, b: undefined }), hashInput({ a: 1 }))
  })
  it('distinguishes genuinely different input', () => {
    assert.notEqual(hashInput({ title: 'Field Day' }), hashInput({ title: 'Field Night' }))
  })
  it('serializes dates stably', () => {
    const d = new Date('2026-04-11T14:00:00Z')
    assert.equal(canonicalize({ startsAt: d }), '{"startsAt":"2026-04-11T14:00:00.000Z"}')
  })
})
