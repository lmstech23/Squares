'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import s from '../../public.module.css'

export default function ManageRsvp({ registrationId, token }: { registrationId: string; token: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function cancel() {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/registrations/${registrationId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ token }),
      })
      if (!res.ok) { setError((await res.json()).message ?? 'Could not cancel.'); return }
      router.refresh()
    } finally { setBusy(false); setConfirming(false) }
  }

  return (
    <div className={s.manage}>
      {error && <div className={s.error}>{error}</div>}
      {!confirming ? (
        <button className={s.linkBtn} onClick={() => setConfirming(true)} disabled={busy}>
          Cancel my RSVP
        </button>
      ) : (
        <div className={s.confirmRow}>
          <span className={s.confirmText}>Cancel and free your seats?</span>
          <button className={s.submit} onClick={cancel} disabled={busy}>
            {busy ? 'Cancelling…' : 'Yes, cancel'}
          </button>
          <button className={s.linkBtn} onClick={() => setConfirming(false)} disabled={busy}>
            Keep it
          </button>
        </div>
      )}
    </div>
  )
}
