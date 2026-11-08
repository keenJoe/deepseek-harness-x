import { describe, expect, it } from 'vitest'
import { userPrincipal, type UserPrincipal } from '@deepseek-ai/dsh-user-principal'
import { CONNECTION_TRUST_TTL_MS, signForwardedUser, verifyForwardedUser } from '../src/connection-trust.ts'

/** Build the fixture caller. */
function alice(): UserPrincipal {
  const user = userPrincipal({ providerId: 'feishu', tenantId: 'tenant-7', subjectId: 'ou_42', displayName: 'Alice' })
  if (user === undefined) throw new Error('fixture identity is empty')
  return user
}

describe('connection trust', () => {
  it('round-trips the caller through the signed header', () => {
    const secret = 'shared-forward-secret'
    const value = signForwardedUser(secret, alice())
    expect(verifyForwardedUser(secret, value)).toEqual(alice())
  })

  it('rejects a proof signed with another secret', () => {
    const value = signForwardedUser('secret-a', alice())
    expect(verifyForwardedUser('secret-b', value)).toBeUndefined()
  })

  it('rejects a stale proof', () => {
    const secret = 'shared'
    const value = signForwardedUser(secret, alice(), 1000)
    expect(verifyForwardedUser(secret, value, 1000 + CONNECTION_TRUST_TTL_MS + 1)).toBeUndefined()
  })

  it('rejects a tampered or malformed proof', () => {
    const secret = 'shared'
    expect(verifyForwardedUser(secret, 'not-base64')).toBeUndefined()
    const value = signForwardedUser(secret, alice())
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    decoded.displayName = 'Mallory'
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    expect(verifyForwardedUser(secret, tampered)).toBeUndefined()
  })
})
