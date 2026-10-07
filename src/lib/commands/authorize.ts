import { fail, type ActorContext, type CommandResult } from './types'

/**
 * [ActorContext is audit and authorization, not a second code path.]
 *
 * `kind` reaches exactly two places: this file, and the actor stamp on log rows.
 * If 'AGENT' ever appears inside src/domain/, the separation has failed.
 */

/** The user whose authority is being exercised, human or agent alike. */
export function effectiveUserId(actor: ActorContext): string | null {
  if (actor.kind === 'AGENT') return actor.onBehalfOfUserId ?? null
  return actor.userId ?? null
}

export function requireOrganizer<T>(
  actor: ActorContext,
): CommandResult<T> | null {
  if (actor.kind === 'AGENT' && !actor.onBehalfOfUserId) {
    return fail<T>('FORBIDDEN', 'An agent must act on behalf of an organizer.')
  }
  if (!effectiveUserId(actor)) {
    return fail<T>('UNAUTHENTICATED', 'Sign in to continue.')
  }
  return null
}

export function requireOwnership<T>(
  actor: ActorContext,
  event: { organizerUserId: string },
): CommandResult<T> | null {
  const uid = effectiveUserId(actor)
  if (!uid || uid !== event.organizerUserId) {
    return fail<T>('FORBIDDEN', 'This event belongs to someone else.')
  }
  return null
}

/** Written onto every log row a command already writes. No separate audit table. */
export function actorStamp(actor: ActorContext) {
  return {
    actorKind: actor.kind,
    actorUserId: effectiveUserId(actor),
    actorEventPersonId: actor.eventPersonId ?? null,
    planExecutionId: actor.planExecutionId ?? null,
  }
}
