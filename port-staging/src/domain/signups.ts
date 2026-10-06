import { assertNever } from './assertNever'

export type SlotType = 'SHIFT' | 'ITEM'

/** Lowest N free positions in 1…capacity, or null if fewer than N remain. */
export function allocatePositions(
  taken: readonly number[],
  capacity: number,
  quantity: number,
): number[] | null {
  const used = new Set(taken)
  const free: number[] = []
  for (let p = 1; p <= capacity && free.length < quantity; p++) {
    if (!used.has(p)) free.push(p)
  }
  // All or nothing. A helper who asked for 3 cases and can only get 2 is told
  // what remains and re-confirms. An organizer reading "3 cases" who receives 2
  // has a real problem at 8am.
  return free.length === quantity ? free : null
}

/**
 * A SHIFT commitment is valid only with exactly one position.
 *
 * This cannot be a check constraint: the predicate would need slot.slotType from
 * another table, which Postgres will not allow — the same limit that stopped the
 * original partial-index draft. So the rule lives in code, and src/db/signups.ts
 * is its sole enforcer.
 */
export function maxQuantityFor(slotType: SlotType): number | null {
  switch (slotType) {
    case 'SHIFT': return 1
    case 'ITEM':  return null
    default: return assertNever(slotType)
  }
}

export function validateQuantity(slotType: SlotType, quantity: number): string | null {
  if (!Number.isInteger(quantity) || quantity < 1) return 'Choose at least 1.'
  const max = maxQuantityFor(slotType)
  if (max !== null && quantity > max) return 'A shift takes one person per sign-up.'
  return null
}

export function slotKindLabel(slotType: SlotType): string {
  switch (slotType) {
    case 'SHIFT': return 'Shift'
    case 'ITEM':  return 'Item'
    default: return assertNever(slotType)
  }
}

/** Item slots carry a unit; shifts carry a time window. Neither borrows the other's. */
export function remainingLabel(slotType: SlotType, remaining: number, unitLabel: string | null): string {
  switch (slotType) {
    case 'SHIFT': return remaining === 0 ? 'Full' : `${remaining} of them open`
    case 'ITEM':  return remaining === 0 ? 'All covered' : `${remaining} ${unitLabel ?? 'more'} needed`
    default: return assertNever(slotType)
  }
}
