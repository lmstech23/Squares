import type { EmailProvider } from '../types'

/** Development default. Sends nothing; proves the pipeline end to end. */
export const consoleProvider: EmailProvider = {
  name: 'console',
  async send(email) {
    console.log(`\n── email ─────────────────────────────
to:      ${email.to}
subject: ${email.subject}
key:     ${email.idempotencyKey}
${email.text}
──────────────────────────────────────\n`)
    return { ok: true, providerMessageId: `console-${email.idempotencyKey}` }
  },
}
