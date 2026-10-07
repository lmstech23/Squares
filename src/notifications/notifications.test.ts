import { describe, it, expect } from 'vitest'
import { renderRsvpConfirmation } from '../src/notifications/templates/rsvpConfirmation'
import { dedupeKeyFor } from '../src/notifications/enqueue'

const data = {
  personName: 'Daaliyah Coleman',
  eventTitle: 'Spring Field Day',
  when: 'Saturday, April 11 at 9:00 AM EDT',
  venue: 'Lincoln Elementary',
  partySize: 3,
  manageUrl: 'https://daali.app/e/spring-field-day/rsvp/abc123',
}

describe('RSVP confirmation template', () => {
  it('carries the facts a guest needs', () => {
    const { subject, text } = renderRsvpConfirmation(data)
    expect(subject).toContain('Spring Field Day')
    expect(text).toContain('Daaliyah Coleman')
    expect(text).toContain('Saturday, April 11')
    expect(text).toContain('3 spots')
    expect(text).toContain(data.manageUrl)
  })

  it('singularizes one spot', () => {
    expect(renderRsvpConfirmation({ ...data, partySize: 1 }).text).toContain('1 spot')
  })

  it('omits the venue line when there is no venue', () => {
    const { text } = renderRsvpConfirmation({ ...data, venue: null })
    expect(text).not.toContain('Where:')
  })

  it('escapes HTML so a title cannot inject markup', () => {
    const { html } = renderRsvpConfirmation({ ...data, eventTitle: '<script>alert(1)</script>' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('dedupe key', () => {
  it('names the registration, not the person — a receipt belongs to a purchase', () => {
    expect(dedupeKeyFor('RSVP_CONFIRMED', 'reg_1')).toBe('registration:reg_1')
    expect(dedupeKeyFor('RSVP_CONFIRMED', 'reg_2')).not.toBe(dedupeKeyFor('RSVP_CONFIRMED', 'reg_1'))
  })
})

import { resolveAppUrl } from '../src/lib/appUrl'

describe('APP_URL validation — a broken manage link must never ship', () => {
  it('rejects unset and empty', () => {
    expect(resolveAppUrl(undefined)).toEqual({ ok: false, error: 'APP_URL is not set' })
    expect(resolveAppUrl('')).toEqual({ ok: false, error: 'APP_URL is not set' })
    expect(resolveAppUrl('   ')).toEqual({ ok: false, error: 'APP_URL is not set' })
  })

  it('rejects a value that is not a URL', () => {
    const r = resolveAppUrl('daali.app')          // no scheme — the common mistake
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/not a valid URL/)
  })

  it('rejects a non-http scheme', () => {
    const r = resolveAppUrl('ftp://daali.app')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/http or https/)
  })

  it('accepts a good origin and strips the trailing slash', () => {
    expect(resolveAppUrl('https://daali.app/')).toEqual({ ok: true, origin: 'https://daali.app' })
    expect(resolveAppUrl('https://daali.app')).toEqual({ ok: true, origin: 'https://daali.app' })
  })

  it('keeps a port and drops a path, so concatenation is safe', () => {
    expect(resolveAppUrl('http://localhost:3000')).toEqual({ ok: true, origin: 'http://localhost:3000' })
    expect(resolveAppUrl('https://daali.app/some/path')).toEqual({ ok: true, origin: 'https://daali.app' })
  })
})
