import { describe, expect, it } from 'vitest'
import { INVALID_ID_TOKEN } from '../src/errors.ts'
import { decodeBase64Url, decodeJsonObject, isRecord, stringField } from '../src/json.ts'
import { base64url, thrown } from './helpers.ts'

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

describe('decodeBase64Url', () => {
  it('decodes base64url text', () => {
    expect(decodeBase64Url(base64url('hello')).toString('utf8')).toBe('hello')
  })
})

describe('decodeJsonObject', () => {
  it('decodes a base64url JSON object', () => {
    expect(decodeJsonObject(base64url('{"a":1}'), 'header')).toEqual({ a: 1 })
  })

  it('reports a segment that is not JSON', () => {
    const error = thrown(() => decodeJsonObject(base64url('not json'), 'payload'))
    expect(error.code).toBe(INVALID_ID_TOKEN)
    expect(error.message).toContain('id_token payload is not base64url-encoded JSON')
  })

  it('reports a segment that is not a JSON object', () => {
    const error = thrown(() => decodeJsonObject(base64url('null'), 'payload'))
    expect(error.code).toBe(INVALID_ID_TOKEN)
    expect(error.message).toContain('id_token payload is not a JSON object')
  })
})
