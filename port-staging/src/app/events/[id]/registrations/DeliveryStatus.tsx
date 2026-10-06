'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import s from '../../events.module.css'

type Props = { deliveryId: string | null; status: 'pending' | 'sent' | 'failed' | null; lastError: string | null }

/** The whole recovery story in 0D.0: the organizer can see it, and press it. */
export default function DeliveryStatus({ deliveryId, status, lastError }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  if (!deliveryId || status === null) return <span className={s.meta}>—</span>

  async function resend() {
    setBusy(true)
    try {
      await fetch(`/api/notifications/${deliveryId}/resend`, { method: 'POST' })
      router.refresh()
    } finally { setBusy(false) }
  }

  if (status === 'sent') return <span className={`${s.badge} ${s.published}`}>emailed</span>

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <span className={`${s.badge} ${s.draft}`} title={lastError ?? undefined}>
        {status === 'failed' ? 'email failed' : 'email pending'}
      </span>
      <button className={`${s.btn} ${s.ghost}`} style={{ padding: '6px 12px', fontSize: 13 }}
        onClick={resend} disabled={busy}>
        {busy ? 'Sending…' : 'Resend'}
      </button>
    </span>
  )
}
