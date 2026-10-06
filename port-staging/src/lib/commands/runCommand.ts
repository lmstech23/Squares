import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'
import { hashInput } from './canonical'
import { fail, ok, type CommandCtx, type CommandResult } from './types'

const UNIQUE_VIOLATION = 'P2002'

type RunOpts<I, O> = {
  name: string
  input: I
  ctx: CommandCtx
  /** scopes the CommandExecution row so cleanup is the event's cleanup */
  eventId?: string | null
  /** the actual work. runs inside the transaction that also records the execution */
  execute: (tx: Prisma.TransactionClient) => Promise<CommandResult<O>>
}

/**
 * Idempotent command runner. [R4]
 *
 * Two properties that between them remove a whole category of decision:
 *
 *   1. The CommandExecution row stores the ACTUAL outbound payload, not a hash.
 *      A hash can tell you a duplicate arrived; it cannot give publishEvent back
 *      its slug.
 *
 *   2. Only successes persist, because the row is written in the same transaction
 *      as the work. A failed command rolls the row back with everything else, so
 *      there is no "was this failure retryable" logic, no failed-row expiry, and
 *      no way for a transient DB error to permanently poison a key.
 */
export async function runCommand<I, O>(opts: RunOpts<I, O>): Promise<CommandResult<O>> {
  const { name, input, ctx, eventId, execute } = opts

  if (!ctx.idempotencyKey) {
    return prisma.$transaction((tx) => execute(tx))
  }

  const inputHash = hashInput(input)

  const replay = await lookup<O>(name, ctx.idempotencyKey, inputHash)
  if (replay) return replay

  try {
    return await prisma.$transaction(async (tx) => {
      const result = await execute(tx)

      // Failures roll back. Nothing is recorded, and a retry runs cleanly.
      if (!result.ok) return result

      await tx.commandExecution.create({
        data: {
          commandName: name,
          idempotencyKey: ctx.idempotencyKey!,
          eventId: eventId ?? null,
          inputHash,
          result: result.data as Prisma.InputJsonValue,
        },
      })

      return result
    })
  } catch (e) {
    // Lost a race against a concurrent identical call. The winner's row is
    // authoritative; return what it recorded.
    if (isUniqueViolation(e)) {
      const raced = await lookup<O>(name, ctx.idempotencyKey, inputHash)
      if (raced) return raced
      return fail<O>('CONFLICT', 'This request is already being processed.')
    }
    throw e
  }
}

async function lookup<O>(
  commandName: string,
  idempotencyKey: string,
  inputHash: string,
): Promise<CommandResult<O> | null> {
  const prior = await prisma.commandExecution.findUnique({
    where: { commandName_idempotencyKey: { commandName, idempotencyKey } },
  })
  if (!prior) return null

  // Same key, different input. Returning the stale result would tell a caller
  // their new event was created when it wasn't. Fail loudly.
  if (prior.inputHash !== inputHash) {
    return fail<O>(
      'IDEMPOTENCY_KEY_CONFLICT',
      'This request key was already used with different data.',
    )
  }

  return ok(prior.result as O)
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === UNIQUE_VIOLATION
}

export { isUniqueViolation }
