import { describe, expect, it } from 'vitest'
import type { IdentityActor } from '@deepseek-ai/dsh-identity-protocol'
import {
  isUser,
  userId,
  userOf,
  userPrincipal,
  type UserId,
  type UserPrincipal,
} from '../src/index.ts'

const actor: IdentityActor = {
  providerId: 'example',
  tenantId: 'tenant/a',
  subjectId: 'user:one',
  displayName: 'Alice',
}

const owner = { kind: 'owner' } as const

describe('userPrincipal', () => {
  it('normalizes the tenant and copies identity fields one by one', () => {
    expect(userPrincipal(actor)).toEqual({
      kind: 'user',
      providerId: 'example',
      tenantId: 'tenant/a',
      subjectId: 'user:one',
      displayName: 'Alice',
    })
    expect(userPrincipal({ ...actor, tenantId: '' })).toEqual({
      kind: 'user',
      providerId: 'example',
      tenantId: 'default',
      subjectId: 'user:one',
      displayName: 'Alice',
    })
  })

  it('drops provider extras a caller might still carry', () => {
    const withExtras = {
      ...actor,
      accessToken: 'secret',
      refreshToken: 'secret',
      avatarUrl: 'https://example.test/avatar.png',
    } as IdentityActor & { accessToken: string; refreshToken: string }
    expect(userPrincipal(withExtras)).toEqual({
      kind: 'user',
      providerId: 'example',
      tenantId: 'tenant/a',
      subjectId: 'user:one',
      displayName: 'Alice',
      avatarUrl: 'https://example.test/avatar.png',
    })
  })

  it('omits the avatar when the provider issued none', () => {
    const principal = userPrincipal(actor)
    expect(principal).toBeDefined()
    expect('avatarUrl' in (principal as UserPrincipal)).toBe(false)
  })

  it('rejects an empty provider or subject id', () => {
    expect(userPrincipal({ ...actor, providerId: '' })).toBeUndefined()
    expect(userPrincipal({ ...actor, subjectId: '' })).toBeUndefined()
  })
})

describe('userOf', () => {
  it('narrows a user principal and answers undefined for every other kind', () => {
    const principal = userPrincipal(actor) as UserPrincipal
    expect(userOf(principal)).toBe(principal)
    expect(userOf(owner)).toBeUndefined()
  })
})

describe('isUser', () => {
  it('compares by the whole identity key', () => {
    const principal = userPrincipal(actor) as UserPrincipal
    expect(isUser(principal, { providerId: 'example', tenantId: 'tenant/a', subjectId: 'user:one' })).toBe(true)
    expect(isUser(principal, { providerId: 'example', tenantId: 'tenant/a', subjectId: 'user:two' })).toBe(false)
    expect(isUser(principal, { providerId: 'other', tenantId: 'tenant/a', subjectId: 'user:one' })).toBe(false)
    expect(isUser(principal, { providerId: 'example', tenantId: 'other', subjectId: 'user:one' })).toBe(false)
  })
})

describe('userId', () => {
  it('brands the canonical identity key', () => {
    const principal = userPrincipal(actor) as UserPrincipal
    const id: UserId = userId(principal)
    expect(id).toBe('example:tenant%2Fa:user%3Aone')
    expect(userId(principal)).toBe(userId(userPrincipal({
      providerId: 'example',
      tenantId: 'tenant/a',
      subjectId: 'user:one',
      displayName: 'Bob',
    }) as UserPrincipal))
  })
})
