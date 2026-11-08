import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { INVALID_ID_TOKEN } from '../src/errors.ts'
import { validateIdTokenClaims, verifyIdTokenSignature } from '../src/id-token.ts'
import { CLIENT_ID, EXP, ISSUER, NOW, PUBLISHED_KEYS, base64url, signToken, thrown, validToken } from './helpers.ts'

const HEADER = base64url('{"alg":"RS256","kid":"key-1"}')

describe('verifyIdTokenSignature', () => {
  it('returns the payload of a token signed by a published key', () => {
    expect(verifyIdTokenSignature(validToken({ scope: 'openid' }), PUBLISHED_KEYS))
      .toMatchObject({ sub: 'subject-1', scope: 'openid' })
  })

  it('rejects a token without three segments', () => {
    expect(thrown(() => verifyIdTokenSignature('a.b', PUBLISHED_KEYS)).message)
      .toContain('three dot-separated segments')
  })

  it('rejects a token with an empty segment', () => {
    expect(thrown(() => verifyIdTokenSignature('a..c', PUBLISHED_KEYS)).message).toContain('empty segment')
  })

  it('rejects a header that is not base64url JSON', () => {
    const token = base64url('not json') + '.' + base64url('{}') + '.' + base64url('sig')
    expect(thrown(() => verifyIdTokenSignature(token, PUBLISHED_KEYS)).message)
      .toContain('header is not base64url-encoded JSON')
  })

  it('rejects a payload that is not base64url JSON', () => {
    const token = HEADER + '.' + base64url('not json') + '.' + base64url('sig')
    expect(thrown(() => verifyIdTokenSignature(token, PUBLISHED_KEYS)).message)
      .toContain('payload is not base64url-encoded JSON')
  })

  it('rejects a header that is not a JSON object', () => {
    const token = base64url('[1]') + '.' + base64url('{}') + '.' + base64url('sig')
    expect(thrown(() => verifyIdTokenSignature(token, PUBLISHED_KEYS)).message)
      .toContain('header is not a JSON object')
  })

  it('rejects a payload that is not a JSON object', () => {
    const token = HEADER + '.' + base64url('null') + '.' + base64url('sig')
    expect(thrown(() => verifyIdTokenSignature(token, PUBLISHED_KEYS)).message)
      .toContain('payload is not a JSON object')
  })

  it('rejects an algorithm other than RS256', () => {
    const token = signToken({ alg: 'HS256', kid: 'key-1' }, { sub: 'subject-1' })
    expect(thrown(() => verifyIdTokenSignature(token, PUBLISHED_KEYS)).message)
      .toContain('only RS256 is accepted')
  })

  it('rejects a header without a key id', () => {
    const token = signToken({ alg: 'RS256' }, { sub: 'subject-1' })
    expect(thrown(() => verifyIdTokenSignature(token, PUBLISHED_KEYS)).message).toContain('names no key id')
  })

  it('rejects an empty key id', () => {
    const token = signToken({ alg: 'RS256', kid: '' }, { sub: 'subject-1' })
    expect(thrown(() => verifyIdTokenSignature(token, PUBLISHED_KEYS)).message).toContain('names no key id')
  })

  it('rejects a key id the published JWKS does not carry', () => {
    const token = signToken({ alg: 'RS256', kid: 'key-2' }, { sub: 'subject-1' })
    expect(thrown(() => verifyIdTokenSignature(token, PUBLISHED_KEYS)).message).toContain('does not carry')
  })

  it('rejects a published key that is not RSA', () => {
    expect(thrown(() => verifyIdTokenSignature(validToken(), [{ kty: 'EC', kid: 'key-1' }])).message)
      .toContain('is not an RSA public key')
  })

  it('rejects a published key without a modulus', () => {
    expect(thrown(() => verifyIdTokenSignature(validToken(), [{ kty: 'RSA', kid: 'key-1', e: 'AQAB' }])).message)
      .toContain('is not an RSA public key')
  })

  it('rejects a published key without an exponent', () => {
    expect(thrown(() => verifyIdTokenSignature(validToken(), [{ kty: 'RSA', kid: 'key-1', n: 'AQAB' }])).message)
      .toContain('is not an RSA public key')
  })


  it('rejects a signature made with another key', () => {
    const token = signToken({ alg: 'RS256', kid: 'key-1' }, { sub: 'subject-1' }, Buffer.from('not a signature'))
    expect(thrown(() => verifyIdTokenSignature(token, PUBLISHED_KEYS)).message)
      .toContain('does not verify against key')
  })
})

const EXPECTED = { issuer: ISSUER, clientId: CLIENT_ID, now: NOW }

describe('validateIdTokenClaims', () => {
  it('returns the standard and profile claims', () => {
    const { claims, tenantId } = validateIdTokenClaims({
      iss: ISSUER,
      sub: 'subject-1',
      aud: CLIENT_ID,
      exp: EXP,
      name: 'Alice',
      preferred_username: 'alice',
      picture: 'https://example.com/alice.png',
    }, EXPECTED)
    expect(claims).toEqual({
      iss: ISSUER,
      sub: 'subject-1',
      exp: EXP,
      name: 'Alice',
      preferredUsername: 'alice',
      picture: 'https://example.com/alice.png',
    })
    expect(tenantId).toBeUndefined()
  })

  it('omits absent profile claims', () => {
    const { claims } = validateIdTokenClaims({ iss: ISSUER, sub: 'subject-1', aud: CLIENT_ID, exp: EXP }, EXPECTED)
    expect(claims).not.toHaveProperty('name')
    expect(claims).not.toHaveProperty('preferredUsername')
    expect(claims).not.toHaveProperty('picture')
  })

  it('rejects a different issuer', () => {
    const error = thrown(() => validateIdTokenClaims({ iss: 'https://other.example.com', sub: 's', aud: CLIENT_ID, exp: EXP }, EXPECTED))
    expect(error.code).toBe(INVALID_ID_TOKEN)
    expect(error.message).toContain('is not the configured issuer')
  })

  it('rejects a token without an issuer', () => {
    expect(thrown(() => validateIdTokenClaims({ sub: 's', aud: CLIENT_ID, exp: EXP }, EXPECTED)).message)
      .toContain('is not the configured issuer')
  })

  it('rejects a token without the client id as audience', () => {
    expect(thrown(() => validateIdTokenClaims({ iss: ISSUER, sub: 's', audit: CLIENT_ID, exp: EXP }, EXPECTED)).message)
      .toContain('audience does not include client id')
  })

  it('accepts an audience array that includes the client id', () => {
    const { claims } = validateIdTokenClaims({ iss: ISSUER, sub: 's', aud: ['other', CLIENT_ID], exp: EXP }, EXPECTED)
    expect(claims.sub).toBe('s')
  })

  it('ignores non-string audience entries', () => {
    expect(thrown(() => validateIdTokenClaims({ iss: ISSUER, sub: 's', aud: [1, 'other'], exp: EXP }, EXPECTED)).message)
      .toContain('audience does not include client id')
  })

  it('rejects a non-numeric expiry', () => {
    expect(thrown(() => validateIdTokenClaims({ iss: ISSUER, sub: 's', aud: CLIENT_ID, exp: 'soon' }, EXPECTED)).message)
      .toContain('no numeric exp claim')
  })

  it('rejects a non-finite expiry', () => {
    expect(thrown(() => validateIdTokenClaims({ iss: ISSUER, sub: 's', aud: CLIENT_ID, exp: Number.NaN }, EXPECTED)).message)
      .toContain('no numeric exp claim')
  })

  it('rejects an elapsed token', () => {
    expect(thrown(() => validateIdTokenClaims({ iss: ISSUER, sub: 's', aud: CLIENT_ID, exp: NOW / 1000 }, EXPECTED)).message)
      .toContain('has expired')
  })

  it('rejects a token without a subject', () => {
    expect(thrown(() => validateIdTokenClaims({ iss: ISSUER, aud: CLIENT_ID, exp: EXP }, EXPECTED)).message)
      .toContain('carries no sub claim')
  })

  it('reads the tenant from the configured claim', () => {
    const { tenantId } = validateIdTokenClaims(
      { iss: ISSUER, sub: 's', aud: CLIENT_ID, exp: EXP, tenant: 'acme' },
      { ...EXPECTED, tenantClaim: 'tenant' },
    )
    expect(tenantId).toBe('acme')
  })

  it('reports an absent tenant claim as undefined', () => {
    const { tenantId } = validateIdTokenClaims(
      { iss: ISSUER, sub: 's', aud: CLIENT_ID, exp: EXP },
      { ...EXPECTED, tenantClaim: 'tenant' },
    )
    expect(tenantId).toBeUndefined()
  })
})
