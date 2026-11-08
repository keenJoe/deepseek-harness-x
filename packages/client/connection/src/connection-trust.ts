/**
 * Trusted-forwarder admission key and header.
 *
 * The entry process and a backend share one forwarding key, separate from the login cookie
 * key. The entry signs the forwarded caller into a header; the backend verifies it and recovers
 * the caller, so the backend never learns the login key and a forged login session is not
 * possible from a backend.
 * @module @deepseek-ai/dsh-client-connection/src/connection-trust
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { userPrincipal, type UserPrincipal } from '@deepseek-ai/dsh-user-principal'
import type { ConnectionTrust } from './rpc.ts'

/** Forwarding header carrying the signed caller. */
export const CONNECTION_TRUST_HEADER = 'x-dsh-forwarded-user'

/** Millisecond lifetime of one forwarding proof; the backend drops stale proofs. */
export const CONNECTION_TRUST_TTL_MS = 5_000

/**
 * One forwarding key: the bytes both sides sign with. It derives from a secret the entry and
 * backend share, never the login cookie key.
 * @param secret - deployment-supplied shared secret.
 * @returns the key bytes.
 */
function keyOf(secret: string): Buffer {
  return Buffer.from(secret, 'utf8')
}

/**
 * Sign one caller for the forwarding header.
 * @param secret - shared forwarding secret.
 * @param user - the caller the entry already authenticated.
 * @param now - current millisecond instant.
 * @returns the header value carrying the proof.
 */
export function signForwardedUser(secret: string, user: UserPrincipal, now = Date.now()): string {
  const body = [now, user.providerId, user.tenantId, user.subjectId, user.displayName].join(',')
  const key = keyOf(secret)
  const signature = createHmac('sha256', key).update(body).digest('base64url')
  return Buffer.from(JSON.stringify({ now, providerId: user.providerId, tenantId: user.tenantId, subjectId: user.subjectId, displayName: user.displayName, signature }), 'utf8').toString('base64url')
}

/**
 * Verify a forwarding header and recover the caller, or undefined when invalid or stale.
 * @param secret - shared forwarding secret.
 * @param value - the header value the entry wrote.
 * @param now - current millisecond instant.
 * @returns the recovered user principal, or undefined.
 */
export function verifyForwardedUser(secret: string, value: string, now = Date.now()): UserPrincipal | undefined {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
  const { now: issuedAt, providerId, tenantId, subjectId, displayName, signature } = parsed
  if (typeof issuedAt !== 'number' || typeof providerId !== 'string' || typeof tenantId !== 'string' || typeof subjectId !== 'string' || typeof displayName !== 'string' || typeof signature !== 'string') {
    return undefined
  }
  if (now - issuedAt > CONNECTION_TRUST_TTL_MS) return undefined
  const body = [issuedAt, providerId, tenantId, subjectId, displayName].join(',')
  const expected = createHmac('sha256', keyOf(secret)).update(body).digest('base64url')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined
  const user = userPrincipal({ providerId, tenantId, subjectId, displayName })
  return user
}

/**
 * Backend-facing trust context: verifies the forwarding header and resolves the caller.
 * @param secret - shared forwarding secret.
 * @returns the ConnectionTrust implementation.
 */
export function createConnectionTrustContext(secret: string): ConnectionTrust {
  return {
    principalOf(request) {
      const headers = request.headers
      const value = headers instanceof Headers ? headers.get(CONNECTION_TRUST_HEADER) : headers[CONNECTION_TRUST_HEADER]
      if (typeof value !== 'string') return undefined
      return verifyForwardedUser(secret, value)
    },
  }
}
