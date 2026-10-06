'use client'

import { useMemo, useState } from 'react'
import s from './public.module.css'

type Props = { eventId: string; slug: string; seatsRemaining: number | null }

export default function RsvpForm({ eventId, slug, seatsRemaining }: Props) {
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ partySize: number; manageUrl: string; updated: boolean } | null>(null)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/events/${eventId}/registrations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          slug,
          name: fd.get('name'),
          email: fd.get('email'),
          phone: fd.get('phone') || null,
          partySize: Number(fd.get('partySize') || 1),
          note: fd.get('note') || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.message ?? 'Something went wrong.'); return }
      setDone({ partySize: data.partySize, manageUrl: data.manageUrl, updated: Boolean(data.updated) })
    } finally { setBusy(false) }
  }

  if (done) {
    return (
      <div className={s.rsvpDone}>
        {/* A repeat RSVP is a CHANGE, not a second registration. Say so. */}
        <p className={s.doneTitle}>{done.updated ? 'Your RSVP has been updated.' : 'You’re in.'}</p>
        <p className={s.doneBody}>
          {done.partySize} seat{done.partySize === 1 ? '' : 's'} {done.updated ? 'now reserved' : 'reserved'}.{' '}
          <a className={s.link} href={done.manageUrl}>Manage your RSVP</a>
        </p>
      </div>
    )
  }

  const full = seatsRemaining === 0
  if (full) return <p className={s.soon}>This event is full.</p>

  return (
    <form className={s.rsvp} onSubmit={onSubmit}>
      <p className={s.rsvpHead}>
        RSVP
        {seatsRemaining !== null && (
          <span className={s.seats}>{seatsRemaining} seat{seatsRemaining === 1 ? '' : 's'} left</span>
        )}
      </p>

      {error && <div className={s.error}>{error}</div>}

      <label className={s.f}><span className={s.l}>Your name</span>
        <input className={s.i} name="name" required disabled={busy} /></label>

      <label className={s.f}><span className={s.l}>Email</span>
        <input className={s.i} name="email" type="email" required disabled={busy} /></label>

      <div className={s.two}>
        <label className={s.f}><span className={s.l}>Phone (optional)</span>
          <input className={s.i} name="phone" disabled={busy} /></label>
        <label className={s.f}><span className={s.l}>How many people?</span>
          <input className={s.i} name="partySize" type="number" min={1} max={20}
            defaultValue={1} disabled={busy} /></label>
      </div>

      <label className={s.f}><span className={s.l}>Anything we should know? (optional)</span>
        <input className={s.i} name="note" disabled={busy} /></label>

      <button className={s.submit} type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Count me in'}
      </button>
    </form>
  )
}
