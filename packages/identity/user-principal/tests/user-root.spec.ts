import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PeerId, Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import {
  callerOf,
  callerRoot,
  isWithinRoot,
  operatorRoot,
  userPrincipal,
  userRoot,
  type UserPrincipal,
} from '../src/index.ts'

/** The fixture caller every case attributes its work to. */
const USER: UserPrincipal = (() => {
  const principal = userPrincipal({ providerId: 'provider', tenantId: 'tenant', subjectId: 'subject', displayName: 'Alice' })
  if (principal === undefined) throw new Error('the fixture identity is empty')
  return principal
})()

describe('durable roots per caller', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-user-root-'))
    vi.stubEnv('DSH_HOME', home)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })

  it('keeps the operator home for in-process code', () => {
    const ctx = new Context()

    expect(callerOf(ctx)).toBeUndefined()
    expect(callerRoot(ctx, 'storages')).toBe(join(home, 'storages'))
    expect(operatorRoot('sessions')).toBe(join(home, 'sessions'))
  })

  it('splits one logged-in caller into its own home', () => {
    const ctx = new Context()
    const scoped = ctx.extend({ invocation: invocationFor(ctx, USER) })

    expect(callerOf(scoped)).toEqual(USER)
    expect(callerRoot(scoped, 'storages')).toBe(userRoot(USER, 'storages'))
    expect(userRoot(USER, 'storages')).toContain(join(home, 'users'))
    expect(userRoot(USER, 'storages')).not.toBe(join(home, 'storages'))
  })

  it('keeps two callers apart', () => {
    const other = userPrincipal({ providerId: 'provider', tenantId: 'tenant', subjectId: 'other', displayName: 'Bob' })
    if (other === undefined) throw new Error('the fixture identity is empty')

    expect(userRoot(USER, 'sessions')).not.toBe(userRoot(other, 'sessions'))
    expect(isWithinRoot(userRoot(USER, 'sessions'), userRoot(other, 'sessions'))).toBe(false)
  })

  it('compares a root at a path-separator boundary', () => {
    expect(isWithinRoot('/harness/users/alice/sessions', '/harness/users/alice')).toBe(true)
    expect(isWithinRoot('/harness/users/alice', '/harness/users/alice')).toBe(true)
    expect(isWithinRoot('/harness/users/alice-2/sessions', '/harness/users/alice')).toBe(false)
    expect(isWithinRoot('/harness/users/alice/', '/harness/users/alice/')).toBe(true)
  })
})

/**
 * Build the invocation one Context reads as its ambient Remote call.
 * @param ctx - Context the fake Peer hangs under.
 * @param principal - caller the invocation speaks for.
 * @returns the invocation record Typert exposes on Context.
 */
function invocationFor(ctx: Context, principal: Principal): RemoteInvocation {
  return {
    request: { namespace: 'storage', method: 'open', args: {} },
    service: 'storageDomain',
    peer: {
      id: 'user-root-peer' as PeerId,
      ctx,
      principal,
      interactions: 'answer',
      signal: new AbortController().signal,
      dispose: async () => {},
    },
    signal: new AbortController().signal,
    uplink: <In>(): AsyncIterable<In> => ({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    }),
  }
}
