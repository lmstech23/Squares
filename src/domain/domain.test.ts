import { describe, it, expect } from 'vitest'
import { isPubliclyVisible, acceptsRegistrations, canTransition, publicStateCopy } from '../src/domain/eventStatus'
import { resolveIdentityKey, isPlausibleEmail } from '../src/domain/identity'
import { slugifyTitle, candidateSlug } from '../src/domain/slug'
import { validateEventDraft } from '../src/domain/eventValidation'
import { canonicalize, hashInput } from '../src/lib/commands/canonical'

describe('event status — allowlist behaviour [R1]', () => {
  it('drafts are not public', () => {
    expect(isPubliclyVisible('DRAFT')).toBe(false)
    expect(isPubliclyVisible('PUBLISHED')).toBe(true)
    expect(isPubliclyVisible('CLOSED')).toBe(true)
  })

  it('closed keeps the URL alive but stops registration', () => {
    expect(isPubliclyVisible('CLOSED')).toBe(true)
    expect(acceptsRegistrations('CLOSED')).toBe(false)
  })

  it('closed has its own sentence, so CANCELLED can have a different one', () => {
    expect(publicStateCopy('PUBLISHED').headline).toBeNull()
    expect(publicStateCopy('CLOSED').headline).toBe('Registration is closed.')
  })

  it('transitions are one-way through the lifecycle', () => {
    expect(canTransition('DRAFT', 'PUBLISHED')).toBe(true)
    expect(canTransition('PUBLISHED', 'CLOSED')).toBe(true)
    expect(canTransition('PUBLISHED', 'DRAFT')).toBe(false)
    expect(canTransition('CLOSED', 'PUBLISHED')).toBe(false)
  })
})

describe('identity normalization', () => {
  it('collapses case and whitespace to one key', () => {
    expect(resolveIdentityKey('Sarah@Example.com ')).toBe('sarah@example.com')
    expect(resolveIdentityKey('  SARAH@EXAMPLE.COM')).toBe(resolveIdentityKey('sarah@example.com'))
  })
  it('rejects obvious non-addresses', () => {
    expect(isPlausibleEmail('sarah@example.com')).toBe(true)
    expect(isPlausibleEmail('sarah')).toBe(false)
    expect(isPlausibleEmail('')).toBe(false)
  })
})

describe('slug', () => {
  it('strips accents and punctuation', () => {
    expect(slugifyTitle('Hampton Parent Tailgate 2026!')).toBe('hampton-parent-tailgate-2026')
    expect(slugifyTitle('Café Night')).toBe('cafe-night')
  })
  it('never produces an empty or trailing-dash base', () => {
    expect(slugifyTitle('!!!')).toBe('event')
    expect(slugifyTitle('a')).toBe('event')
  })
  it('appends a suffix so two identical titles do not collide', () => {
    const a = candidateSlug('Spring Field Day')
    const b = candidateSlug('Spring Field Day')
    expect(a).not.toBe(b)
    expect(a.startsWith('spring-field-day-')).toBe(true)
  })
})

describe('validation', () => {
  it('rejects an end before the start', () => {
    const errs = validateEventDraft({
      title: 'Field Day', timezone: 'America/New_York',
      startsAt: new Date('2026-04-11T14:00:00Z'), endsAt: new Date('2026-04-11T13:00:00Z'),
    })
    expect(errs.some((e) => e.field === 'endsAt')).toBe(true)
  })
  it('rejects a bogus timezone', () => {
    expect(validateEventDraft({ timezone: 'Mars/Olympus' }).some((e) => e.field === 'timezone')).toBe(true)
    expect(validateEventDraft({ timezone: 'America/New_York' })).toEqual([])
  })
  it('rejects fractional or zero capacity', () => {
    expect(validateEventDraft({ capacity: 0 }).length).toBe(1)
    expect(validateEventDraft({ capacity: 2.5 }).length).toBe(1)
    expect(validateEventDraft({ capacity: null })).toEqual([])
  })
})

describe('canonical input hashing [R4]', () => {
  it('is stable across key order', () => {
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ b: 2, a: 1 }))
  })
  it('treats undefined and absent as the same input', () => {
    expect(hashInput({ a: 1, b: undefined })).toBe(hashInput({ a: 1 }))
  })
  it('distinguishes genuinely different input', () => {
    expect(hashInput({ title: 'Field Day' })).not.toBe(hashInput({ title: 'Field Night' }))
  })
  it('serializes dates stably', () => {
    const d = new Date('2026-04-11T14:00:00Z')
    expect(canonicalize({ startsAt: d })).toBe('{"startsAt":"2026-04-11T14:00:00.000Z"}')
  })
})
