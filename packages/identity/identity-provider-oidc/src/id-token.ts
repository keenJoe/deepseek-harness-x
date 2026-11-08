/**
 * RS256 id_token verification built on `node:crypto`.
 *
 * Only `RS256` is accepted: the token header's `kid` selects one published JWK,
 * the signature is verified against that key's public half, and the standard
 * `iss`, `aud`, `exp`, and `sub` claims are then validated. This module fetches
 * nothing; the caller owns retrieval and caching of the JWKS document.
 *
 * @module @deepseek-ai/dsh-identity-provider-oidc/src/id-token
 */

import { Buffer } from 'node:buffer'
import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import { INVALID_ID_TOKEN, OidcProviderError } from './errors.ts'
import { decodeBase64Url, decodeJsonObject, stringField } from './json.ts'

/** One RSA public key as a JWKS document publishes it. */
export interface RsaJwk {
  /** Key type; only `RSA` can verify an RS256 signature. */
  readonly kty: string
  /** Key id the id_token header names. */
  readonly kid?: string
  /** RSA modulus, base64url. */
  readonly n?: string
  /** RSA public exponent, base64url. */
  readonly e?: string
}

/** id_token claims this provider reads once the signature verifies. */
export interface IdTokenClaims {
  /** Issuer that signed the token. */
  readonly iss: string
  /** Issuer-scoped subject id. */
  readonly sub: string
  /** Expiry instant, in whole seconds since the Unix epoch. */
  readonly exp: number
  /** Display name the issuer publishes, when it does. */
  readonly name?: string
  /** Login name the issuer publishes, when it does. */
  readonly preferredUsername?: string
  /** Avatar URL the issuer publishes, when it does. */
  readonly picture?: string
}

/** Facts claim validation checks the token against. */
export interface IdTokenExpectations {
  /** Issuer the token must declare. */
  readonly issuer: string
  /** Audience the token must name. */
  readonly clientId: string
  /** Current instant, in milliseconds since the Unix epoch. */
  readonly now: number
  /** Claim naming the tenant, when the deployment configures one. */
  readonly tenantClaim?: string
}

/** One successfully validated token. */
export interface ValidatedIdToken {
  /** Validated standard claims and the profile claims this provider records. */
  readonly claims: IdTokenClaims
  /** Tenant id the configured claim carried, when the deployment configures one. */
  readonly tenantId: string | undefined
}

/** Decoded segments of one compact JWS. */
interface ParsedJwt {
  readonly header: Record<string, unknown>
  readonly payload: Record<string, unknown>
  readonly signingInput: Buffer
  readonly signature: Buffer
}

function parseJwt(token: string): ParsedJwt {
  const segments = token.split('.')
  if (segments.length !== 3) {
    throw new OidcProviderError('id_token must have three dot-separated segments', INVALID_ID_TOKEN)
  }
  const [header, payload, signature] = segments
  if (header === undefined || payload === undefined || signature === undefined) {
    throw new OidcProviderError('id_token must have three dot-separated segments', INVALID_ID_TOKEN)
  }
  if (header === '' || payload === '' || signature === '') {
    throw new OidcProviderError('id_token contains an empty segment', INVALID_ID_TOKEN)
  }
  return {
    header: decodeJsonObject(header, 'header'),
    payload: decodeJsonObject(payload, 'payload'),
    signingInput: Buffer.from(header + '.' + payload),
    signature: decodeBase64Url(signature),
  }
}

function publicKeyOf(jwk: RsaJwk, kid: string): KeyObject {
  if (jwk.kty !== 'RSA' || jwk.n === undefined || jwk.e === undefined) {
    throw new OidcProviderError('id_token key ' + JSON.stringify(kid) + ' is not an RSA public key', INVALID_ID_TOKEN)
  }
  return createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' })
}

function audiencesOf(payload: Record<string, unknown>): readonly string[] {
  const aud = payload.aud
  if (typeof aud === 'string') return [aud]
  if (Array.isArray(aud)) return aud.filter((value): value is string => typeof value === 'string')
  return []
}

/**
 * Verify one RS256 id_token signature and return its payload.
 * @param token - compact JWS id_token as the token endpoint returned it.
 * @param keys - RSA public keys the issuer publishes.
 * @returns the verified payload; claims are not yet validated.
 * @throws {OidcProviderError} code `INVALID_ID_TOKEN` for a malformed token, an algorithm
 * other than RS256, an absent or unpublished key id, or a bad signature.
 */
export function verifyIdTokenSignature(token: string, keys: readonly RsaJwk[]): Record<string, unknown> {
  const parsed = parseJwt(token)
  const algorithm = parsed.header.alg
  if (algorithm !== 'RS256') {
    throw new OidcProviderError('id_token algorithm ' + String(algorithm) + ' is not supported; only RS256 is accepted', INVALID_ID_TOKEN)
  }
  const kid = parsed.header.kid
  if (typeof kid !== 'string' || kid === '') {
    throw new OidcProviderError('id_token header names no key id', INVALID_ID_TOKEN)
  }
  const jwk = keys.find(key => key.kid === kid)
  if (jwk === undefined) {
    throw new OidcProviderError('id_token names key ' + JSON.stringify(kid) + ', which the published JWKS does not carry', INVALID_ID_TOKEN)
  }
  if (!verify('RSA-SHA256', parsed.signingInput, publicKeyOf(jwk, kid), parsed.signature)) {
    throw new OidcProviderError('id_token signature does not verify against key ' + JSON.stringify(kid), INVALID_ID_TOKEN)
  }
  return parsed.payload
}

/**
 * Validate the standard id_token claims of an already verified payload.
 * @param payload - payload returned by {@link verifyIdTokenSignature}.
 * @param expected - issuer, audience, current instant, and optional tenant claim name.
 * @returns validated claims and the tenant id the configured claim carried.
 * @throws {OidcProviderError} code `INVALID_ID_TOKEN` for a different issuer or audience,
 * an absent or elapsed expiry, or an absent subject.
 */
export function validateIdTokenClaims(payload: Record<string, unknown>, expected: IdTokenExpectations): ValidatedIdToken {
  if (stringField(payload, 'iss') !== expected.issuer) {
    throw new OidcProviderError('id_token issuer is not the configured issuer ' + JSON.stringify(expected.issuer), INVALID_ID_TOKEN)
  }
  if (!audiencesOf(payload).includes(expected.clientId)) {
    throw new OidcProviderError('id_token audience does not include client id ' + JSON.stringify(expected.clientId), INVALID_ID_TOKEN)
  }
  const exp = payload.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw new OidcProviderError('id_token carries no numeric exp claim', INVALID_ID_TOKEN)
  }
  if (exp * 1000 <= expected.now) {
    throw new OidcProviderError('id_token has expired', INVALID_ID_TOKEN)
  }
  const sub = stringField(payload, 'sub')
  if (sub === undefined) {
    throw new OidcProviderError('id_token carries no sub claim', INVALID_ID_TOKEN)
  }
  const name = stringField(payload, 'name')
  const preferredUsername = stringField(payload, 'preferred_username')
  const picture = stringField(payload, 'picture')
  return {
    claims: {
      iss: expected.issuer,
      sub,
      exp,
      ...(name === undefined ? {} : { name }),
      ...(preferredUsername === undefined ? {} : { preferredUsername }),
      ...(picture === undefined ? {} : { picture }),
    },
    tenantId: expected.tenantClaim === undefined ? undefined : stringField(payload, expected.tenantClaim),
  }
}
