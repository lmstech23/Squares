'use client'

import { useMemo, useState } from 'react'
import s from './public.module.css'

export type PublicSlot = {
  id: string
  slotType: 'SHIFT' | 'ITEM'
  name: string
  notes: string | null
  unitLabel: string | null
  when: string | null
  capacity: number
  taken: number
}

export default function SignupSheetSection({
  slug, title, instructions, slots,
}: { slug: string; title: string; instructions: string | null; slots: PublicSlot[] }) {
  const [openSlot, setOpenSlot] = useState<string | null>(null)
  const [done, setDone] = useState<Record<string, number>>({})

  return (
    <section className={s.sheet}>
      <p className={s.sheetHead}>{title}</p>
      {instructions && <p className={s.sheetNote}>{instructions}</p>}

      {slots.map((slot) => {
        const remaining = Math.max(0, slot.capacity - slot.taken) - (done[slot.id] ?? 0)
        const full = remaining === 0
        return (
          <div key={slot.id} className={s.slot}>
            <div className={s.slotMain}>
              <div className={s.slotName}>{slot.name}</div>
              <div className={s.slotMeta}>
                {slot.when ?? (slot.unitLabel ? `Bring ${slot.unitLabel}` : null)}
                {slot.notes ? (slot.when || slot.unitLabel ? ` · ${slot.notes}` : slot.notes) : ''}
              </div>
            </div>

            <div className={s.slotRight}>
              <span className={full ? s.slotFull : s.slotOpen}>
                {full
                  ? (slot.slotType === 'SHIFT' ? 'Full' : 'All covered')
                  : `${remaining} of ${slot.capacity}`}
              </span>
              {!full && (
                <button className={s.slotBtn} onClick={() => setOpenSlot(openSlot === slot.id ? null : slot.id)}>
                  {openSlot === slot.id ? 'Close' : 'Sign up'}
                </button>
              )}
            </div>

            {openSlot === slot.id && (
              <ClaimForm
                slug={slug}
                slot={slot}
                remaining={remaining}
                onDone={(qty) => {
                  setDone((d) => ({ ...d, [slot.id]: (d[slot.id] ?? 0) + qty }))
                  setOpenSlot(null)
                }}
              />
            )}
          </div>
        )
      })}
    </section>
  )
}

function ClaimForm({
  slug, slot, remaining, onDone,
}: { slug: string; slot: PublicSlot; remaining: number; onDone: (qty: number) => void }) {
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const quantity = slot.slotType === 'SHIFT' ? 1 : Number(fd.get('quantity') || 1)
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/slots/${slot.id}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          slug, quantity,
          name: fd.get('name'), email: fd.get('email'), note: fd.get('note') || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.message ?? 'Could not sign up.'); return }
      onDone(quantity)
    } finally { setBusy(false) }
  }

  return (
    <form className={s.claim} onSubmit={submit}>
      {error && <div className={s.error}>{error}</div>}
      <div className={s.two}>
        <label className={s.f}><span className={s.l}>Your name</span>
          <input className={s.i} name="name" required disabled={busy} /></label>
        <label className={s.f}><span className={s.l}>Email</span>
          <input className={s.i} name="email" type="email" required disabled={busy} /></label>
      </div>

      {/* A shift takes one person. Only an item asks how many. */}
      {slot.slotType === 'ITEM' && (
        <label className={s.f}>
          <span className={s.l}>How many {slot.unitLabel ?? 'to bring'}?</span>
          <input className={s.i} name="quantity" type="number" min={1} max={remaining}
            defaultValue={1} disabled={busy} />
        </label>
      )}

      <label className={s.f}><span className={s.l}>Note (optional)</span>
        <input className={s.i} name="note" disabled={busy} /></label>

      <button className={s.submit} type="submit" disabled={busy}>
        {busy ? 'Signing up…' : 'Count me in'}
      </button>
    </form>
  )
}
