export type NotificationType = 'RSVP_CONFIRMED'
export type NotificationStatus = 'pending' | 'sent' | 'failed'

export type OutboundEmail = {
  to: string
  subject: string
  text: string
  html: string
  /** Stable across attempts, and never including the attempt number. The case it
   *  protects is a send that timed out but actually delivered. */
  idempotencyKey: string
}

export type SendOutcome =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; error: string }

export interface EmailProvider {
  readonly name: string
  send(email: OutboundEmail, signal?: AbortSignal): Promise<SendOutcome>
}
