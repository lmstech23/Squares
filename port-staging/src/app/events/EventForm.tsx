'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import s from './events.module.css'

type Locked = Record<string, string>   // field -> reason, from the capability contract

type Props = {
  mode: 'create' | 'edit'
  eventId?: string
  initial?: Record<string, string>
  locked?: Locked
  status?: 'DRAFT' | 'PUBLISHED' | 'CLOSED'
  slug?: string | null
}

/**
 * One idempotency key per form render. A double-tap on a slow connection replays
 * the original command rather than creating a second event. [R4]
 */
export default function EventForm({ mode, eventId, initial = {}, locked = {}, status, slug }: Props) {
  const router = useRouter()
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [])
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [banner, setBanner] = useState<string | null>(null)

  async function send(url: string, method: string, body?: unknown, key = idempotencyKey) {
    setBusy(true); setErrors({}); setBanner(null)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: body ? JSON.stringify(body) : undefined,
      })
      const data = await res.json()
      if (!res.ok) {
        if (Array.isArray(data.details)) {
          const map: Record<string, string> = {}
          for (const d of data.details) map[d.field] = d.message
          setErrors(map)
        }
        setBanner(data.message ?? 'Something went wrong.')
        return null
      }
      return data
    } finally {
      setBusy(false)
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const payload: Record<string, unknown> = {}
    // forEach rather than entries(): does not require the dom.iterable lib.
    fd.forEach((v, k) => {
      if (locked[k]) return                   // never send a field the contract locked
      payload[k] = v === '' ? null : v
    })
    if (payload.title === null) payload.title = ''

    if (mode === 'create') {
      const data = await send('/api/events', 'POST', payload)
      if (data?.eventId) router.push(`/events/${data.eventId}/edit`)
    } else {
      const data = await send(`/api/events/${eventId}`, 'PATCH', payload, crypto.randomUUID())
      if (data) { setBanner('Saved.'); router.refresh() }
    }
  }

  async function onPublish() {
    const data = await send(`/api/events/${eventId}/publish`, 'POST', undefined, crypto.randomUUID())
    if (data?.slug) router.refresh()
  }

  async function onClose() {
    const data = await send(`/api/events/${eventId}/close`, 'POST', undefined, crypto.randomUUID())
    if (data) router.refresh()
  }

  const field = (name: string, label: string, type = 'text', extra: Record<string, unknown> = {}) => (
    <label className={s.field}>
      <span className={s.label}>{label}</span>
      <input
        className={s.input}
        name={name}
        type={type}
        defaultValue={initial[name] ?? ''}
        disabled={Boolean(locked[name]) || busy}
        {...extra}
      />
      {locked[name] && <div className={s.locked}>{locked[name]}</div>}
      {errors[name] && <div className={s.err}>{errors[name]}</div>}
    </label>
  )

  return (
    <form onSubmit={onSubmit}>
      {banner && <div className={s.banner}>{banner}</div>}

      {field('title', 'Event name')}

      <label className={s.field}>
        <span className={s.label}>Description</span>
        <textarea className={s.textarea} name="description" rows={3}
          defaultValue={initial.description ?? ''} disabled={busy} />
      </label>

      <div className={s.grid2}>
        {field('startsAt', 'Starts', 'datetime-local')}
        {field('endsAt', 'Ends (optional)', 'datetime-local')}
      </div>

      <div className={s.grid2}>
        {field('timezone', 'Time zone', 'text', { placeholder: 'America/New_York' })}
        {field('capacity', 'Capacity (optional)', 'number', { min: 1 })}
      </div>

      <div className={s.grid2}>
        {field('venueName', 'Venue')}
        {field('venueAddress', 'Address')}
      </div>

      <div className={s.actions}>
        <button className={`${s.btn} ${s.primary}`} type="submit" disabled={busy}>
          {mode === 'create' ? 'Create draft' : 'Save changes'}
        </button>

        {mode === 'edit' && status === 'DRAFT' && (
          <button className={`${s.btn} ${s.ghost}`} type="button" onClick={onPublish} disabled={busy}>
            Publish
          </button>
        )}

        {mode === 'edit' && status === 'PUBLISHED' && (
          <>
            <a className={`${s.btn} ${s.ghost}`} href={`/e/${slug}`} target="_blank" rel="noreferrer">
              View public page
            </a>
            <button className={`${s.btn} ${s.ghost}`} type="button" onClick={onClose} disabled={busy}>
              Close registration
            </button>
          </>
        )}
      </div>
    </form>
  )
}
