import type { EmailProvider } from '../types'

/**
 * One provider adapter. Swapping it is a one-line change in index.ts — nothing
 * else in the codebase knows which service sends mail.
 */
export const resendProvider: EmailProvider = {
  name: 'resend',
  async send(email, signal) {
    const key = process.env.RESEND_API_KEY
    const from = process.env.EMAIL_FROM
    if (!key || !from) return { ok: false, error: 'RESEND_API_KEY or EMAIL_FROM is not set' }

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          // Protects the timed-out-but-delivered case. A key that changed per
          // attempt would mail her twice.
          'Idempotency-Key': email.idempotencyKey,
        },
        body: JSON.stringify({
          from, to: [email.to], subject: email.subject, text: email.text, html: email.html,
        }),
      })

      if (!res.ok) return { ok: false, error: `${res.status} ${(await res.text()).slice(0, 400)}` }
      const data = (await res.json()) as { id?: string }
      return { ok: true, providerMessageId: data.id ?? null }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
}
