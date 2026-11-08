import { describe, expect, it } from 'vitest'
import { isRecord, stringField } from '../src/json.ts'

describe('isRecord', () => {
  it('accepts a plain object', () => {
    expect(isRecord({ a: 1 })).toBe(true)
  })
  it('rejects null, arrays, and primitives', () => {
    expect(isRecord(null)).toBe(false)
    expect(isRecord([1])).toBe(false)
    expect(isRecord('text')).toBe(false)
  })
})

describe('stringField', () => {
  it('returns a non-empty string member', () => {
    expect(stringField({ a: 'x' }, 'a')).toBe('x')
  })
  it('ignores an absent, empty, or non-string member', () => {
    expect(stringField({}, 'a')).toBeUndefined()
    expect(stringField({ a: '' }, 'a')).toBeUndefined()
    expect(stringField({ a: 1 }, 'a')).toBeUndefined()
  })
})
