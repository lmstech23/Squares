import { assertNever } from './assertNever'

export type EventStatus = 'DRAFT' | 'PUBLISHED' | 'CLOSED'

/**
 * RULE [R1]: nothing in this codebase may write `status !== 'PUBLISHED'`, and no
 * switch over EventStatus may have a fall-through default. Allowlist the states
 * that permit a thing; never denylist the ones that don't.
 *
 * When CANCELLED lands, every function below breaks the build. That is the review.
 */

/** Is the public /e/[slug] page reachable at all? */
export function isPubliclyVisible(status: EventStatus): boolean {
  switch (status) {
    case 'DRAFT':     return false
    case 'PUBLISHED': return true
    case 'CLOSED':    return true
    default: return assertNever(status)
  }
}

/** May a new registration be created? Wired up for real in 0B. */
export function acceptsRegistrations(status: EventStatus): boolean {
  switch (status) {
    case 'DRAFT':     return false
    case 'PUBLISHED': return true
    case 'CLOSED':    return false
    default: return assertNever(status)
  }
}

export type PublicStateCopy = { headline: string | null; tone: 'live' | 'muted' }

/**
 * The public page's words. CANCELLED's whole point is that this returns a
 * different sentence than CLOSED — "this will not happen" vs "registration is over".
 */
export function publicStateCopy(status: EventStatus): PublicStateCopy {
  switch (status) {
    case 'DRAFT':     return { headline: null, tone: 'muted' }
    case 'PUBLISHED': return { headline: null, tone: 'live' }
    case 'CLOSED':    return { headline: 'Registration is closed.', tone: 'muted' }
    default: return assertNever(status)
  }
}

export function canTransition(from: EventStatus, to: EventStatus): boolean {
  switch (from) {
    case 'DRAFT':     return to === 'PUBLISHED'
    case 'PUBLISHED': return to === 'CLOSED'
    case 'CLOSED':    return false
    default: return assertNever(from)
  }
}
