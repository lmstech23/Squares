import { describe, it, expect } from 'vitest'
import { allocatePositions, validateQuantity, maxQuantityFor, remainingLabel } from '../src/domain/signups'

describe('position allocation — the capacity guarantee', () => {
  it('takes the lowest free numbers', () => {
    expect(allocatePositions([], 6, 3)).toEqual([1, 2, 3])
    expect(allocatePositions([1, 3], 6, 2)).toEqual([2, 4])
  })

  it('is all or nothing — never returns fewer than asked', () => {
    expect(allocatePositions([1, 2, 3, 4, 5], 6, 2)).toBeNull()
    expect(allocatePositions([1, 2, 3, 4, 5], 6, 1)).toEqual([6])
  })

  it('reuses numbers freed by a cancellation (a seat, not a credential)', () => {
    // position 2 was cancelled; the next claimant gets it back
    expect(allocatePositions([1, 3], 3, 1)).toEqual([2])
  })

  it('returns null on a full slot rather than an empty array', () => {
    expect(allocatePositions([1, 2], 2, 1)).toBeNull()
  })
})

describe('SHIFT vs ITEM', () => {
  it('a shift takes exactly one position per person', () => {
    expect(maxQuantityFor('SHIFT')).toBe(1)
    expect(validateQuantity('SHIFT', 2)).toMatch(/one person/i)
    expect(validateQuantity('SHIFT', 1)).toBeNull()
  })

  it('an item takes any positive quantity', () => {
    expect(maxQuantityFor('ITEM')).toBeNull()
    expect(validateQuantity('ITEM', 4)).toBeNull()
    expect(validateQuantity('ITEM', 0)).toMatch(/at least 1/i)
    expect(validateQuantity('ITEM', 2.5)).toMatch(/at least 1/i)
  })

  it('each kind gets its own language', () => {
    expect(remainingLabel('SHIFT', 2, null)).toMatch(/open/)
    expect(remainingLabel('SHIFT', 0, null)).toBe('Full')
    expect(remainingLabel('ITEM', 3, 'cases of water')).toContain('cases of water')
    expect(remainingLabel('ITEM', 0, 'cases of water')).toBe('All covered')
  })
})
