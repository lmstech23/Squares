/**
 * The command boundary. The organizer UI calls these. Daali will call the same
 * ones. There is no second path and no privileged persistence escape hatch.
 */

export type ActorContext = {
  kind: 'HUMAN' | 'AGENT'
  /** organizer identity, when a human organizer is acting */
  userId?: string
  /** public participant, when a human participant is acting (0B onward) */
  eventPersonId?: string
  /** REQUIRED when kind === 'AGENT'. Whose authority is being exercised */
  onBehalfOfUserId?: string
  /** set when kind === 'AGENT'. Null otherwise. Phase 2 joins on this */
  planExecutionId?: string
}

export type CommandCtx = {
  actor: ActorContext
  idempotencyKey?: string
  /** injectable clock. tests need it, and so will plan replay */
  now?: Date
}

export type CommandErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'ILLEGAL_TRANSITION'
  | 'FIELD_IMMUTABLE'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'CONFLICT'
  | 'INTERNAL'

export type CommandResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: CommandErrorCode; message: string; details?: unknown }

export const ok = <T>(data: T): CommandResult<T> => ({ ok: true, data })

export const fail = <T = never>(
  code: CommandErrorCode,
  message: string,
  details?: unknown,
): CommandResult<T> => ({ ok: false, code, message, details })

/**
 * Commands never throw for expected failures. CAPACITY_EXCEEDED and SLOT_FULL are
 * results, because Phase 2 has to branch on them without parsing stack traces.
 */
export type Command<I, O> = (input: I, ctx: CommandCtx) => Promise<CommandResult<O>>
