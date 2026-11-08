import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import IdentityProviderService from '@deepseek-ai/dsh-identity-providers'
import type { IdentityProvider } from '@deepseek-ai/dsh-identity-protocol'
import OidcIdentityProvider, {
  Config,
  DISCOVERY_FAILED,
  INVALID_ID_TOKEN,
  OidcProviderError,
  TOKEN_REQUEST_FAILED,
  isOidcProviderError,
} from '../src/index.ts'
import {
  CLIENT_ID,
  ISSUER,
  NOW,
  PUBLISHED_KEYS,
  stubFetch,
  thrown,
  validToken,
} from './helpers.ts'

const DISCOVERY_URL = ISSUER + '/.well-known/openid-configuration'

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: ISSUER + '/authorize',
  token_endpoint: ISSUER + '/token',
  jwks_uri: ISSUER + '/jwks',
}

const STATIC = {
  id: 'example',
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: 'client-secret',
  authorizationEndpoint: ISSUER + '/authorize',
  tokenEndpoint: ISSUER + '/token',
  jwksUri: ISSUER + '/jwks',
}

const REDIRECT_URI = 'https://app.example.com/login/callback'

/** One JSON response carrying `body`. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A token with every profile claim the provider records. */
function fullToken(claims: Record<string, unknown> = {}): string {
  return validToken({ name: 'Alice', preferred_username: 'alice', picture: 'https://example.com/alice.png', ...claims })
}

/** Route scripted responses by request URL. */
function routed(routes: Record<string, () => Response>) {
  return stubFetch(async (url) => {
    const route = routes[url]
    if (route === undefined) throw new Error('unexpected fetch ' + url)
    return route()
  })
}

/** Load the plugin into a context that also hosts the identity-provider registry. */
async function load(config: Record<string, unknown> = STATIC) {
  const ctx = new Context()
  await ctx.plugin(IdentityProviderService)
  const fiber = ctx.plugin(OidcIdentityProvider, config)
  await fiber
  return { ctx, fiber }
}

/** Attempt a load and return nothing; the rejection is the assertion target. */
async function attempt(config: Record<string, unknown>): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(IdentityProviderService)
  await ctx.plugin(OidcIdentityProvider, config)
}

/** The registered adapter, asserted present. */
function providerOf(ctx: Context): IdentityProvider {
  const provider = ctx.identityProviders.get('example')
  if (provider === undefined) throw new Error('adapter not registered')
  return provider
}

/** The provider failure a rejected load or exchange produced. */
async function failure(promise: Promise<unknown>): Promise<OidcProviderError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof OidcProviderError) return error
    throw error
  }
  throw new Error('expected a rejection')
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('registration', () => {
  it('registers one adapter with the configured scopes and withdraws it on dispose', async () => {
    const { ctx, fiber } = await load()
    const provider = providerOf(ctx)
    expect(provider.id).toBe('example')
    expect(provider.scopes).toEqual(['openid', 'profile', 'email'])
    expect(ctx.identityProviders.list()).toEqual(['example'])
    await fiber.dispose()
    expect(ctx.identityProviders.list()).toEqual([])
  })

  it('keeps the scopes the deployment configured', async () => {
    const { ctx } = await load({ ...STATIC, scopes: ['openid', 'profile'] })
    expect(providerOf(ctx).scopes).toEqual(['openid', 'profile'])
  })

  it('refuses a second adapter under the same id', async () => {
    const { ctx } = await load()
    await expect(ctx.plugin(OidcIdentityProvider, STATIC)).rejects.toThrow()
  })
})

describe('config validation', () => {
  it('rejects an issuer that is not an absolute URL', async () => {
    await expect(attempt({ ...STATIC, issuer: 'not a url' })).rejects.toThrow('OIDC issuer must be an absolute URL')
  })

  it('rejects an issuer that is not HTTP(S)', async () => {
    await expect(attempt({ ...STATIC, issuer: 'ftp://issuer.example.com' })).rejects.toThrow('OIDC issuer must be an HTTP(S) URL')
  })

  it('rejects an endpoint that carries credentials', async () => {
    await expect(attempt({ ...STATIC, issuer: 'https://:secret@issuer.example.com' })).rejects.toThrow('without credentials or a fragment')
  })

  it('rejects an endpoint that carries a fragment', async () => {
    await expect(attempt({ ...STATIC, issuer: 'https://issuer.example.com#frag' })).rejects.toThrow('without credentials or a fragment')
  })

  it('rejects a static endpoint that is not HTTP(S)', async () => {
    await expect(attempt({ ...STATIC, authorizationEndpoint: 'ftp://issuer.example.com/authorize' }))
      .rejects.toThrow('OIDC authorizationEndpoint must be an HTTP(S) URL')
  })

  it('rejects a static endpoint that is not an absolute URL', async () => {
    await expect(attempt({ ...STATIC, tokenEndpoint: 'not a url' }))
      .rejects.toThrow('OIDC tokenEndpoint must be an absolute URL')
  })

  it('rejects an incomplete static endpoint trio', async () => {
    const config = {
      id: STATIC.id,
      issuer: STATIC.issuer,
      clientId: STATIC.clientId,
      clientSecret: STATIC.clientSecret,
      authorizationEndpoint: STATIC.authorizationEndpoint,
      tokenEndpoint: STATIC.tokenEndpoint,
    }
    await expect(attempt(config)).rejects.toThrow('authorizationEndpoint, tokenEndpoint, and jwksUri must be configured together')
  })

  it('rejects a config without an id', async () => {
    const config = {
      issuer: STATIC.issuer,
      clientId: STATIC.clientId,
      clientSecret: STATIC.clientSecret,
      authorizationEndpoint: STATIC.authorizationEndpoint,
      tokenEndpoint: STATIC.tokenEndpoint,
      jwksUri: STATIC.jwksUri,
    }
    await expect(attempt(config)).rejects.toThrow('missing required value')
  })
})

describe('discovery', () => {
  it('resolves the endpoints from the issuer document', async () => {
    const fetchMock = routed({ [DISCOVERY_URL]: () => jsonResponse(DISCOVERY) })
    const { ctx } = await load({ id: 'example', issuer: ISSUER, clientId: CLIENT_ID })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(DISCOVERY_URL)
    const url = providerOf(ctx).authorizationUrl({ state: 'state-1', redirectUri: REDIRECT_URI, scopes: ['openid'] })
    expect(url.origin + url.pathname).toBe(ISSUER + '/authorize')
  })

  it('accepts an issuer written with a trailing slash', async () => {
    const fetchMock = routed({ [DISCOVERY_URL]: () => jsonResponse({ ...DISCOVERY, issuer: ISSUER + '/' }) })
    await load({ id: 'example', issuer: ISSUER + '/', clientId: CLIENT_ID })
    expect(fetchMock.mock.calls[0]?.[0]).toBe(DISCOVERY_URL)
  })

  it('reports a document that declares a different issuer', async () => {
    routed({ [DISCOVERY_URL]: () => jsonResponse({ ...DISCOVERY, issuer: 'https://other.example.com' }) })
    const error = await failure(attempt({ id: 'example', issuer: ISSUER, clientId: CLIENT_ID }))
    expect(error.code).toBe('INVALID_DISCOVERY')
    expect(error.message).toContain('declares issuer')
  })

  it('reports a document without an issuer', async () => {
    routed({ [DISCOVERY_URL]: () => jsonResponse({ ...DISCOVERY, issuer: undefined }) })
    await expect(attempt({ id: 'example', issuer: ISSUER, clientId: CLIENT_ID }))
      .rejects.toThrow('declares issuer ""')
  })

  it('reports a document that omits an endpoint', async () => {
    routed({ [DISCOVERY_URL]: () => jsonResponse({ ...DISCOVERY, jwks_uri: undefined }) })
    await expect(attempt({ id: 'example', issuer: ISSUER, clientId: CLIENT_ID }))
      .rejects.toThrow('omits authorization_endpoint, token_endpoint, or jwks_uri')
  })

  it('reports a transport failure', async () => {
    stubFetch(async () => { throw new Error('offline') })
    const error = await failure(attempt({ id: 'example', issuer: ISSUER, clientId: CLIENT_ID }))
    expect(error.code).toBe(DISCOVERY_FAILED)
    expect(error.message).toContain('request to ' + DISCOVERY_URL + ' failed')
  })

  it('reports an HTTP failure', async () => {
    routed({ [DISCOVERY_URL]: () => jsonResponse({}, 503) })
    await expect(attempt({ id: 'example', issuer: ISSUER, clientId: CLIENT_ID }))
      .rejects.toThrow('failed with HTTP 503')
  })

  it('reports a body that is not JSON', async () => {
    stubFetch(async () => new Response('not json', { status: 200 }))
    await expect(attempt({ id: 'example', issuer: ISSUER, clientId: CLIENT_ID }))
      .rejects.toThrow('is not JSON')
  })

  it('reports a body that is not a JSON object', async () => {
    routed({ [DISCOVERY_URL]: () => jsonResponse([]) })
    await expect(attempt({ id: 'example', issuer: ISSUER, clientId: CLIENT_ID }))
      .rejects.toThrow('is not a JSON object')
  })
})

describe('authorizationUrl', () => {
  it('carries the OAuth parameters, PKCE, and the login hint', async () => {
    const { ctx } = await load()
    const url = providerOf(ctx).authorizationUrl({
      state: 'state-1',
      redirectUri: REDIRECT_URI,
      scopes: ['openid', 'profile'],
      loginHint: 'alice@example.com',
      codeChallenge: 'challenge-1',
      codeChallengeMethod: 'S256',
    })
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('scope')).toBe('openid profile')
    expect(url.searchParams.get('state')).toBe('state-1')
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('login_hint')).toBe('alice@example.com')
  })

  it('omits PKCE and the login hint when the request carries neither', async () => {
    const { ctx } = await load()
    const url = providerOf(ctx).authorizationUrl({ state: 'state-1', redirectUri: REDIRECT_URI, scopes: ['openid'] })
    expect(url.searchParams.has('code_challenge')).toBe(false)
    expect(url.searchParams.has('login_hint')).toBe(false)
  })

  it('defaults the PKCE method to S256', async () => {
    const { ctx } = await load()
    const url = providerOf(ctx).authorizationUrl({ state: 'state-1', redirectUri: REDIRECT_URI, scopes: ['openid'], codeChallenge: 'challenge-1' })
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('refuses to build a URL before the discovery document resolved', async () => {
    stubFetch(async () => jsonResponse(DISCOVERY))
    const ctx = new Context()
    await ctx.plugin(IdentityProviderService)
    const config: Config = Config({ id: 'example', issuer: ISSUER, clientId: CLIENT_ID })
    new OidcIdentityProvider(ctx, config)
    const error = thrown(() => providerOf(ctx).authorizationUrl({ state: 'state-1', redirectUri: REDIRECT_URI, scopes: ['openid'] }))
    expect(error.code).toBe(DISCOVERY_FAILED)
    expect(error.message).toContain('resolved no endpoints')
  })
})

describe('exchange', () => {
  it('exchanges the code for a verified identity', async () => {
    const fetchMock = routed({
      [STATIC.tokenEndpoint]: () => jsonResponse({ id_token: fullToken() }),
      [STATIC.jwksUri]: () => jsonResponse({ keys: [...PUBLISHED_KEYS] }),
    })
    const { ctx } = await load({ ...STATIC, defaultTenant: 'acme' })
    const actor = await providerOf(ctx).exchange({ code: 'code-1', state: 'state-1', redirectUri: REDIRECT_URI, codeVerifier: 'verifier-1' })
    expect(actor).toEqual({
      providerId: 'example',
      tenantId: 'acme',
      subjectId: 'subject-1',
      displayName: 'Alice',
      avatarUrl: 'https://example.com/alice.png',
    })
    const init = fetchMock.mock.calls[0]?.[1]
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({
      authorization: 'Basic ' + Buffer.from(CLIENT_ID + ':client-secret').toString('base64'),
    })
    expect(tokenRequestBody(init).get('code_verifier')).toBe('verifier-1')
    expect(tokenRequestBody(init).get('grant_type')).toBe('authorization_code')
  })

  it('sends no client authentication and no verifier when neither is configured', async () => {
    const fetchMock = routed({
      [STATIC.tokenEndpoint]: () => jsonResponse({ id_token: validToken() }),
      [STATIC.jwksUri]: () => jsonResponse({ keys: [...PUBLISHED_KEYS] }),
    })
    const { ctx } = await load({ ...STATIC, clientSecret: undefined, defaultTenant: 'acme' })
    await providerOf(ctx).exchange({ code: 'code-1', state: 'state-1', redirectUri: REDIRECT_URI })
    const init = fetchMock.mock.calls[0]?.[1]
    expect(init?.headers).not.toHaveProperty('authorization')
    expect(tokenRequestBody(init).has('code_verifier')).toBe(false)
  })

  it('falls back from the display name to the login name', async () => {
    routed({
      [STATIC.tokenEndpoint]: () => jsonResponse({ id_token: validToken({ preferred_username: 'alice' }) }),
      [STATIC.jwksUri]: () => jsonResponse({ keys: [...PUBLISHED_KEYS] }),
    })
    const { ctx } = await load({ ...STATIC, defaultTenant: 'acme' })
    const actor = await providerOf(ctx).exchange({ code: 'code-1', state: 'state-1', redirectUri: REDIRECT_URI })
    expect(actor.displayName).toBe('alice')
    expect(actor.avatarUrl).toBeUndefined()
  })

  it('falls back from the display name to the subject', async () => {
    routed({
      [STATIC.tokenEndpoint]: () => jsonResponse({ id_token: validToken() }),
      [STATIC.jwksUri]: () => jsonResponse({ keys: [...PUBLISHED_KEYS] }),
    })
    const { ctx } = await load({ ...STATIC, defaultTenant: 'acme' })
    const actor = await providerOf(ctx).exchange({ code: 'code-1', state: 'state-1', redirectUri: REDIRECT_URI })
    expect(actor.displayName).toBe('subject-1')
  })

  it('reads the tenant from the configured claim', async () => {
    routed({
      [STATIC.tokenEndpoint]: () => jsonResponse({ id_token: validToken({ tenant: 'claim-tenant' }) }),
      [STATIC.jwksUri]: () => jsonResponse({ keys: [...PUBLISHED_KEYS] }),
    })
    const { ctx } = await load({ ...STATIC, tenantClaim: 'tenant', defaultTenant: 'default-tenant' })
    const actor = await providerOf(ctx).exchange({ code: 'code-1', state: 'state-1', redirectUri: REDIRECT_URI })
    expect(actor.tenantId).toBe('claim-tenant')
  })

  it('refuses an identity without a tenant id', async () => {
    routed({
      [STATIC.tokenEndpoint]: () => jsonResponse({ id_token: validToken() }),
      [STATIC.jwksUri]: () => jsonResponse({ keys: [...PUBLISHED_KEYS] }),
    })
    const { ctx } = await load()
    const error = await failure(providerOf(ctx).exchange({ code: 'code-1', state: 'state-1', redirectUri: REDIRECT_URI }))
    expect(error.code).toBe(INVALID_ID_TOKEN)
    expect(error.message).toContain('resolved no tenant id')
  })

  it('refuses a token without an id_token', async () => {
    routed({ [STATIC.tokenEndpoint]: () => jsonResponse({ token_type: 'Bearer' }) })
    const { ctx } = await load()
    const error = await failure(providerOf(ctx).exchange({ code: 'code-1', state: 'state-1', redirectUri: REDIRECT_URI }))
    expect(error.code).toBe(TOKEN_REQUEST_FAILED)
    expect(error.message).toContain('returned no id_token')
  })

  it('reports a rejected token request', async () => {
    routed({ [STATIC.tokenEndpoint]: () => jsonResponse({ error: 'invalid_grant' }, 400) })
    const { ctx } = await load()
    const error = await failure(providerOf(ctx).exchange({ code: 'code-1', state: 'state-1', redirectUri: REDIRECT_URI }))
    expect(error.code).toBe(TOKEN_REQUEST_FAILED)
    expect(error.message).toContain('failed with HTTP 400')
  })

  it('reports a JWKS document without a keys array', async () => {
    routed({
      [STATIC.tokenEndpoint]: () => jsonResponse({ id_token: validToken() }),
      [STATIC.jwksUri]: () => jsonResponse({ keys: 'nope' }),
    })
    const { ctx } = await load()
    await expect(providerOf(ctx).exchange({ code: 'code-1', state: 'state-1', redirectUri: REDIRECT_URI }))
      .rejects.toThrow('carries no keys array')
  })

  it('reports a JWKS document without a usable key', async () => {
    routed({
      [STATIC.tokenEndpoint]: () => jsonResponse({ id_token: validToken() }),
      [STATIC.jwksUri]: () => jsonResponse({ keys: ['nope', { kid: 'untyped' }] }),
    })
    const { ctx } = await load()
    await expect(providerOf(ctx).exchange({ code: 'code-1', state: 'state-1', redirectUri: REDIRECT_URI }))
      .rejects.toThrow('publishes no usable key')
  })

  it('filters unusable JWKS entries and caches the usable ones', async () => {
    const fetchMock = routed({
      [STATIC.tokenEndpoint]: () => jsonResponse({ id_token: fullToken() }),
      [STATIC.jwksUri]: () => jsonResponse({ keys: ['nope', ...PUBLISHED_KEYS] }),
    })
    const { ctx } = await load({ ...STATIC, defaultTenant: 'acme' })
    await providerOf(ctx).exchange({ code: 'code-1', state: 'state-1', redirectUri: REDIRECT_URI })
    await providerOf(ctx).exchange({ code: 'code-2', state: 'state-2', redirectUri: REDIRECT_URI })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.filter(call => call[0] === STATIC.jwksUri)).toHaveLength(1)
  })
})

describe('failures', () => {
  it('identifies its own failures', () => {
    expect(isOidcProviderError(new OidcProviderError('boom', INVALID_ID_TOKEN))).toBe(true)
    expect(isOidcProviderError(new Error('boom'))).toBe(false)
  })
})

/**
 * Parse the form body a token request sent.
 * @param init - the request init the provider handed the fetch mock.
 * @returns the decoded form fields.
 */
function tokenRequestBody(init: RequestInit | undefined): URLSearchParams {
  const body = init?.body
  if (typeof body !== 'string') throw new Error('the token request body is not URL-encoded text')
  return new URLSearchParams(body)
}
