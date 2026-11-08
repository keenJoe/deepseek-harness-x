import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {
  IdentityActor,
  IdentityAuthorizationRequest,
  IdentityExchangeRequest,
} from '@deepseek-ai/dsh-identity-protocol'
import IdentityProviderService, {
  DUPLICATE_PROVIDER,
  INVALID_PROVIDER,
  IdentityProviderError,
  isIdentityProviderError,
  type IdentityProvider,
} from '../src/index.ts'

/** A provider adapter that resolves every callback to one fixed actor. */
function adapter(id: string, scopes: readonly string[] = ['openid']): IdentityProvider {
  return {
    id,
    scopes,
    authorizationUrl(request: IdentityAuthorizationRequest): URL {
      const url = new URL(request.redirectUri)
      url.searchParams.set('code', 'fixed')
      url.searchParams.set('state', request.state)
      return url
    },
    async exchange(request: IdentityExchangeRequest): Promise<IdentityActor> {
      expect(request.state).toBeTypeOf('string')
      return { providerId: id, tenantId: 'tenant', subjectId: 'subject', displayName: 'Alice' }
    },
  }
}

/** A context with only the identity-provider registry mounted. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(IdentityProviderService)
  return ctx
}

/** The identity-provider error a call threw, asserted non-null. */
function thrown(fn: () => void): IdentityProviderError {
  try {
    fn()
  } catch (error) {
    if (isIdentityProviderError(error)) return error
    throw new Error('expected IdentityProviderError, got ' + String(error))
  }
  throw new Error('expected a throw')
}

describe('register', () => {
  it('publishes an adapter and returns a disposer that withdraws it', async () => {
    const ctx = await harness()
    const dispose = ctx.identityProviders.register('example', adapter('example'))
    expect(ctx.identityProviders.list()).toEqual(['example'])
    expect(ctx.identityProviders.get('example')).toBeDefined()
    dispose()
    expect(ctx.identityProviders.list()).toEqual([])
    expect(ctx.identityProviders.get('example')).toBeUndefined()
  })

  it('keeps registration order in list()', async () => {
    const ctx = await harness()
    ctx.identityProviders.register('first', adapter('first'))
    ctx.identityProviders.register('second', adapter('second'))
    expect(ctx.identityProviders.list()).toEqual(['first', 'second'])
  })

  it('refuses a second registration under the same id', async () => {
    const ctx = await harness()
    ctx.identityProviders.register('example', adapter('example'))
    const error = thrown(() => ctx.identityProviders.register('example', adapter('example')))
    expect(error.code).toBe(DUPLICATE_PROVIDER)
    expect(error.message).toBe('an identity provider with id "example" is already registered')
  })

  it('refuses an empty id', async () => {
    const ctx = await harness()
    const error = thrown(() => ctx.identityProviders.register('', adapter('other')))
    expect(error.code).toBe(INVALID_PROVIDER)
    expect(error.message).toBe('an identity provider id must be a non-empty string')
  })

  it('refuses an adapter whose id does not match the registration id', async () => {
    const ctx = await harness()
    const error = thrown(() => ctx.identityProviders.register('example', adapter('other')))
    expect(error.code).toBe(INVALID_PROVIDER)
    expect(error.message).toBe('an identity provider registered as "example" must declare the same adapter id; found "other"')
  })

  it('refuses an adapter that declares no scopes', async () => {
    const ctx = await harness()
    const error = thrown(() => ctx.identityProviders.register('example', adapter('example', [])))
    expect(error.code).toBe(INVALID_PROVIDER)
    expect(error.message).toBe('identity provider "example" declares no scopes')
  })

  it('publishes nothing when a registration fails', async () => {
    const ctx = await harness()
    thrown(() => ctx.identityProviders.register('example', adapter('other')))
    expect(ctx.identityProviders.list()).toEqual([])
    expect(ctx.identityProviders.get('example')).toBeUndefined()
  })
})

describe('get', () => {
  it('answers undefined for an unknown id', async () => {
    const ctx = await harness()
    expect(ctx.identityProviders.get('missing')).toBeUndefined()
  })
})

describe('IdentityProviderError', () => {
  it('carries a stable code and name', () => {
    const error = new IdentityProviderError('boom', DUPLICATE_PROVIDER)
    expect(error.code).toBe('DUPLICATE_PROVIDER')
    expect(error.name).toBe('IdentityProviderError')
  })

  it('is narrowed by isIdentityProviderError', () => {
    expect(isIdentityProviderError(new IdentityProviderError('boom', INVALID_PROVIDER))).toBe(true)
    expect(isIdentityProviderError(new Error('boom'))).toBe(false)
    expect(isIdentityProviderError('boom')).toBe(false)
  })
})
