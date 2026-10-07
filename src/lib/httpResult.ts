import { NextResponse } from 'next/server'
import type { CommandErrorCode, CommandResult } from '@/lib/commands/types'

const STATUS: Record<CommandErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  ILLEGAL_TRANSITION: 409,
  FIELD_IMMUTABLE: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  CONFLICT: 409,
  INTERNAL: 500,
}

/** Commands own the outcome. Routes only translate it. */
export function toResponse<T>(result: CommandResult<T>, successStatus = 200) {
  if (result.ok) return NextResponse.json(result.data, { status: successStatus })
  return NextResponse.json(
    { error: result.code, message: result.message, details: result.details ?? null },
    { status: STATUS[result.code] },
  )
}

export function unauthenticated() {
  return NextResponse.json({ error: 'UNAUTHENTICATED', message: 'Sign in to continue.' }, { status: 401 })
}

/** Client sends one per form render, so a double-tap replays instead of duplicating. */
export function idempotencyKeyFrom(req: Request): string | undefined {
  return req.headers.get('Idempotency-Key') ?? undefined
}
