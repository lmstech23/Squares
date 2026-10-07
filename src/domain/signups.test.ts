import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { allocatePositions, validateQuantity, maxQuantityFor, remainingLabel } from './signups.ts'

describe('position allocation — the capacity guarantee', () => {
  it('takes the lowest free numbers', () => {
    assert.deepEqual(allocatePositions([], 6, 3), [1, 2, 3])
    assert.deepEqual(allocatePositions([1, 3], 6, 2), [2, 4])
  })

  it('is all or nothing — never returns fewer than asked', () => {
    assert.equal(allocatePositions([1, 2, 3, 4, 5], 6, 2), null)
    assert.deepEqual(allocatePositions([1, 2, 3, 4, 5], 6, 1), [6])
  })

  it('reuses numbers freed by a cancellation (a seat, not a credential)', () => {
    // position 2 was cancelled; the next claimant gets it back
    assert.deepEqual(allocatePositions([1, 3], 3, 1), [2])
  })

  it('returns null on a full slot rather than an empty array', () => {
    assert.equal(allocatePositions([1, 2], 2, 1), null)
  })
})

describe('SHIFT vs ITEM', () => {
  it('a shift takes exactly one position per person', () => {
    assert.equal(maxQuantityFor('SHIFT'), 1)
    assert.match(validateQuantity('SHIFT', 2) as string, /one person/i)
    assert.equal(validateQuantity('SHIFT', 1), null)
  })

  it('an item takes any positive quantity', () => {
    assert.equal(maxQuantityFor('ITEM'), null)
    assert.equal(validateQuantity('ITEM', 4), null)
    assert.match(validateQuantity('ITEM', 0) as string, /at least 1/i)
    assert.match(validateQuantity('ITEM', 2.5) as string, /at least 1/i)
  })

  it('each kind gets its own language', () => {
    assert.match(remainingLabel('SHIFT', 2, null), /open/)
    assert.equal(remainingLabel('SHIFT', 0, null), 'Full')
    assert.ok(remainingLabel('ITEM', 3, 'cases of water').includes('cases of water'))
    assert.equal(remainingLabel('ITEM', 0, 'cases of water'), 'All covered')
  })
})
