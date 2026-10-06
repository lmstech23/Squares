'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import s from '../../events.module.css'

export default function SlotManager({ eventId, isOpen }: { eventId: string; isOpen: boolean }) {
  const router = useRouter()
  const [slotType, setSlotType] = useState<'SHIFT' | 'ITEM'>('SHIFT')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function post(body: unknown) {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/events/${eventId}/slots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body),
      })
      if (!res.ok) { setError((await res.json()).message ?? 'Could not save.'); return false }
      router.refresh()
      return true
    } finally { setBusy(false) }
  }

  async function addSlot(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const okDone = await post({
      slotType,
      name: fd.get('name'),
      capacity: Number(fd.get('capacity') || 1),
      startsAt: slotType === 'SHIFT' ? fd.get('startsAt') || null : null,
      endsAt: slotType === 'SHIFT' ? fd.get('endsAt') || null : null,
      unitLabel: slotType === 'ITEM' ? fd.get('unitLabel') || null : null,
      notes: fd.get('notes') || null,
    })
    if (okDone) (e.target as HTMLFormElement).reset()
  }

  return (
    <div className={s.card} style={{ marginBottom: 26 }}>
      {error && <div className={s.banner}>{error}</div>}

      <div className={s.actions} style={{ marginTop: 0, marginBottom: 18 }}>
        <button type="button" disabled={busy}
          className={`${s.btn} ${slotType === 'SHIFT' ? s.primary : s.ghost}`}
          onClick={() => setSlotType('SHIFT')}>Shift</button>
        <button type="button" disabled={busy}
          className={`${s.btn} ${slotType === 'ITEM' ? s.primary : s.ghost}`}
          onClick={() => setSlotType('ITEM')}>Item</button>
        <button type="button" disabled={busy} className={`${s.btn} ${s.ghost}`}
          style={{ marginLeft: 'auto' }}
          onClick={() => post({ action: 'setOpen', isOpen: !isOpen })}>
          {isOpen ? 'Close sign-ups' : 'Reopen sign-ups'}
        </button>
      </div>

      <form onSubmit={addSlot}>
        <div className={s.grid2}>
          <label className={s.field}><span className={s.label}>
            {slotType === 'SHIFT' ? 'Task or role' : 'What do you need?'}</span>
            <input className={s.input} name="name" required disabled={busy}
              placeholder={slotType === 'SHIFT' ? 'Setup crew' : 'Cases of water'} /></label>
          <label className={s.field}><span className={s.label}>
            {slotType === 'SHIFT' ? 'How many people?' : 'How many needed?'}</span>
            <input className={s.input} name="capacity" type="number" min={1} defaultValue={1} disabled={busy} /></label>
        </div>

        {/* A shift carries a time window; an item carries a unit. Neither borrows the other's. */}
        {slotType === 'SHIFT' ? (
          <div className={s.grid2}>
            <label className={s.field}><span className={s.label}>Starts</span>
              <input className={s.input} name="startsAt" type="datetime-local" disabled={busy} /></label>
            <label className={s.field}><span className={s.label}>Ends</span>
              <input className={s.input} name="endsAt" type="datetime-local" disabled={busy} /></label>
          </div>
        ) : (
          <label className={s.field}><span className={s.label}>Unit label</span>
            <input className={s.input} name="unitLabel" disabled={busy} placeholder="case of water" /></label>
        )}

        <label className={s.field}><span className={s.label}>Notes (optional)</span>
          <input className={s.input} name="notes" disabled={busy} placeholder="Meet at the north tent" /></label>

        <button className={`${s.btn} ${s.primary}`} type="submit" disabled={busy}>
          {busy ? 'Adding…' : 'Add'}
        </button>
      </form>
    </div>
  )
}
