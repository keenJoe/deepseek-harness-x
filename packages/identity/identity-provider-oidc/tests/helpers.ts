/** Shared fixtures for the OpenID Connect provider tests. */

import { Buffer } from 'node:buffer'
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { vi } from 'vitest'
import { OidcProviderError } from '../src/errors.ts'
import type { RsaJwk } from '../src/id-token.ts'

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })

/** Private half the fixtures sign id_tokens with. */
export const signingKey: KeyObject = pair.privateKey

const publicJwk = pair.publicKey.export({ format: 'jwk' })
if (publicJwk.n === undefined || publicJwk.e === undefined) {
  throw new Error('the generated RSA key published no modulus or exponent')
}

/** Published key matching {@link signingKey}. */
export const PUBLISHED_KEYS: readonly RsaJwk[] = [
  { kty: 'RSA', kid: 'key-1', n: publicJwk.n, e: publicJwk.e },
]

/** Instant the fixtures treat as now, in milliseconds since the Unix epoch. */
export const NOW = 1_700_000_000_000

/** Expiry instant the fixtures treat as still valid, in seconds since the Unix epoch. */
export const EXP = NOW / 1000 + 600

/** Issuer every fixture token and discovery document declares. */
export const ISSUER = 'https://issuer.example.com'

/** Client id every fixture token names as its audience. */
export const CLIENT_ID = 'client-id'

/**
 * Encode text or bytes as base64url.
 * @param value - text or raw bytes.
 * @returns the unpadded base64url encoding.
 */
export function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

/**
 * Build one compact JWS over the supplied segments.
 * @param header - JOSE header members.
 * @param payload - claim set members.
 * @param signature - pre-made signature bytes; defaults to a real RS256 signature.
 * @returns the compact serialization.
 */
export function signToken(header: Record<string, unknown>, payload: Record<string, unknown>, signature?: Buffer): string {
  const signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload))
  return signingInput + '.' + base64url(signature ?? createSign('RSA-SHA256').update(signingInput).sign(signingKey))
}

/**
 * Build one RS256 token over the fixture claims.
 * @param claims - claim set members layered over the default valid claims.
 * @returns the compact serialization.
 */
export function validToken(claims: Record<string, unknown> = {}): string {
  return signToken({ alg: 'RS256', kid: 'key-1', typ: 'JWT' }, {
    iss: ISSUER,
    sub: 'subject-1',
    aud: CLIENT_ID,
    exp: EXP,
    ...claims,
  })
}

/**
 * Run a synchronous call and return the OIDC failure it threw.
 * @param fn - the call expected to throw.
 * @returns the thrown provider failure.
 */
export function thrown(fn: () => void): OidcProviderError {
  try {
    fn()
  } catch (error) {
    if (error instanceof OidcProviderError) return error
    throw error
  }
  throw new Error('expected a throw')
}

/**
 * Replace the global fetch with one scripted responder.
 * @param handler - responder invoked with the request URL and init.
 * @returns the mock, which records every call.
 */
export function stubFetch(handler: (url: string, init: RequestInit | undefined) => Promise<Response>) {
  const mock = vi.fn(handler)
  vi.stubGlobal('fetch', mock)
  return mock
}
