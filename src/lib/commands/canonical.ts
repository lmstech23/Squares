import { createHash } from 'crypto'

/**
 * Stable hash of command input. [R4]
 *
 * CommandCtx is NOT part of this. The same command replayed by the organizer and
 * by Daali is still the same command — `actor` differing must not read as a conflict.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return v.map(sortValue)
  if (typeof v === 'object') {
    const src = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) {
      if (src[k] === undefined) continue   // undefined and absent are the same input
      out[k] = sortValue(src[k])
    }
    return out
  }
  return v
}

export function hashInput(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex')
}
