import { createClient } from '@/lib/supabase/server'

/**
 * The ONLY auth integration point for the Event path. (README-0A)
 *
 * RULE E1 — this function resolves IDENTITY AND NOTHING ELSE.
 *
 * It must never:
 *   - read the host record, or any table on the Board path
 *   - call the host-session helper that the Board dashboard uses, or any
 *     wrapper around the guard in front of the board list
 *   - touch the payment-preference, credit-balance, or Stripe-status columns
 *     on that record
 *   - redirect
 *
 * The authoritative list of forbidden identifiers lives in RULE E2 of
 * `event-path-gate-independence.md` and is enforced by
 * `scripts/check-event-isolation.sh`. It is deliberately NOT restated here:
 * the guard counts comments as violations, so naming those columns even in
 * order to forbid them would fail the check against this very file.
 *
 * Identity ("who is this") and eligibility ("may they do this") are separate
 * concerns. This function owns only the first. Pointing it at the Board path's
 * session helper is a one-line change that silently imports the entire Board
 * gate chain into every Event route — four Stripe redirects that nobody wrote
 * and that no amount of reading the Event code will reveal.
 *
 * Event eligibility, in full: a signed-in Supabase user may create an Event.
 */

export type Organizer = {
  /** Supabase user id. Stored on Event.organizerUserId — NOT a foreign key. */
  userId: string
  /** Display only. Never an identity key. */
  email: string | null
}

/** Returns null when there is no session. Never throws for absence. */
export async function currentOrganizer(): Promise<Organizer | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()

  if (error || !data?.user) return null

  return {
    userId: data.user.id,
    email: data.user.email ?? null,
  }
}

/**
 * For routes that require a session. Returns a CommandResult-shaped failure
 * rather than throwing, so route handlers branch on it like any other command
 * outcome. (Plan §1: commands never throw for expected failures.)
 */
export async function requireOrganizer(): Promise<
  { ok: true; organizer: Organizer } | { ok: false; code: 'UNAUTHENTICATED' }
> {
  const organizer = await currentOrganizer()
  if (!organizer) return { ok: false, code: 'UNAUTHENTICATED' }
  return { ok: true, organizer }
}

/**
 * Ownership check for a specific event. This is the complete authorization
 * model for organizer commands: does this actor own this event.
 *
 * It never asks whether the actor has paid for anything.
 */
export function ownsEvent(organizer: Organizer, event: { organizerUserId: string }): boolean {
  return event.organizerUserId === organizer.userId
}
