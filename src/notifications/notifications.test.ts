import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderRsvpConfirmation } from './templates/rsvpConfirmation.ts'
import { dedupeKeyFor } from './enqueue.ts'

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
    assert.ok(subject.includes('Spring Field Day'))
    assert.ok(text.includes('Daaliyah Coleman'))
    assert.ok(text.includes('Saturday, April 11'))
    assert.ok(text.includes('3 spots'))
    assert.ok(text.includes(data.manageUrl))
  })

  it('singularizes one spot', () => {
    assert.ok(renderRsvpConfirmation({ ...data, partySize: 1 }).text.includes('1 spot'))
  })

  it('omits the venue line when there is no venue', () => {
    const { text } = renderRsvpConfirmation({ ...data, venue: null })
    assert.ok(!text.includes('Where:'))
  })

  it('escapes HTML so a title cannot inject markup', () => {
    const { html } = renderRsvpConfirmation({ ...data, eventTitle: '<script>alert(1)</script>' })
    assert.ok(!html.includes('<script>'))
    assert.ok(html.includes('&lt;script&gt;'))
  })
})

describe('dedupe key', () => {
  it('names the registration, not the person — a receipt belongs to a purchase', () => {
    assert.equal(dedupeKeyFor('RSVP_CONFIRMED', 'reg_1'), 'registration:reg_1')
    assert.notEqual(dedupeKeyFor('RSVP_CONFIRMED', 'reg_2'), dedupeKeyFor('RSVP_CONFIRMED', 'reg_1'))
  })
})

import { resolveAppUrl } from '../lib/appUrl.ts'

describe('APP_URL validation — a broken manage link must never ship', () => {
  it('rejects unset and empty', () => {
    assert.deepEqual(resolveAppUrl(undefined), { ok: false, error: 'APP_URL is not set' })
    assert.deepEqual(resolveAppUrl(''), { ok: false, error: 'APP_URL is not set' })
    assert.deepEqual(resolveAppUrl('   '), { ok: false, error: 'APP_URL is not set' })
  })

  it('rejects a value that is not a URL', () => {
    const r = resolveAppUrl('daali.app')          // no scheme — the common mistake
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /not a valid URL/)
  })

  it('rejects a non-http scheme', () => {
    const r = resolveAppUrl('ftp://daali.app')
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /http or https/)
  })

  it('accepts a good origin and strips the trailing slash', () => {
    assert.deepEqual(resolveAppUrl('https://daali.app/'), { ok: true, origin: 'https://daali.app' })
    assert.deepEqual(resolveAppUrl('https://daali.app'), { ok: true, origin: 'https://daali.app' })
  })

  it('keeps a port and drops a path, so concatenation is safe', () => {
    assert.deepEqual(resolveAppUrl('http://localhost:3000'), { ok: true, origin: 'http://localhost:3000' })
    assert.deepEqual(resolveAppUrl('https://daali.app/some/path'), { ok: true, origin: 'https://daali.app' })
  })
})
