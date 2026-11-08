import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import IdentityProviderService from '@deepseek-ai/dsh-identity-providers'
import type { IdentityProvider } from '@deepseek-ai/dsh-identity-protocol'
import { INVALID_TOKEN_RESPONSE, INVALID_USER_INFO, isFeishuProviderError } from '../src/errors.ts'
import FeishuIdentityProvider from '../src/index.ts'

const BASE = 'https://open.feishu.example/open-apis/'
const APP_ID = 'cli_app_123'
const APP_SECRET = 'app-secret'
const REDIRECT = 'https://host.example/login/callback'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

interface Call {
  readonly url: string
  readonly init: RequestInit
}

function routed(routes: Record<string, (init: RequestInit) => Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? new URL(input).href : input instanceof URL ? input.href : new URL(input.url).href
    calls.push({ url, init: init ?? {} })
    const route = routes[url]
    if (route === undefined) return jsonResponse({ code: -1, msg: 'unexpected route ' + url })
    return route(init ?? {})
  }) as unknown as typeof fetch
  return { fetch: fetchMock, calls }
}

async function adapter(fetchMock: typeof fetch, extra: Record<string, unknown> = {}): Promise<IdentityProvider> {
  vi.stubGlobal('fetch', fetchMock)
  const ctx = new Context()
  await ctx.plugin(IdentityProviderService)
  await ctx.plugin(FeishuIdentityProvider, { id: 'feishu', appId: APP_ID, appSecret: APP_SECRET, baseUrl: BASE, ...extra })
  const registered = ctx.identityProviders.get('feishu')
  if (registered === undefined) throw new Error('feishu adapter did not register')
  return registered
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('authorizationUrl', () => {
  it('points at the Feishu authorize endpoint with app_id, redirect, and state', async () => {
    const p = await adapter(routed({}).fetch)
    const url = p.authorizationUrl({ state: 'state-1', redirectUri: REDIRECT, scopes: [] })
    expect(url.origin + url.pathname).toBe('https://open.feishu.example/open-apis/authen/v1/authorize')
    expect(url.searchParams.get('app_id')).toBe(APP_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(url.searchParams.get('state')).toBe('state-1')
  })
})

describe('exchange', () => {
  it('exchanges the code, reads the user, and resolves the identity', async () => {
    const { fetch } = routed({
      'https://open.feishu.example/open-apis/authen/v2/oauth/token': () => jsonResponse({ code: 0, data: { access_token: 'u-abc' } }),
      'https://open.feishu.example/open-apis/authen/v1/user_info': () => jsonResponse({ code: 0, data: { open_id: 'ou_1', tenant_key: 't-1', name: 'Alice', avatar_url: 'https://img/a.png' } }),
    })
    const p = await adapter(fetch)
    const actor = await p.exchange({ code: 'code-1', state: 'state-1', redirectUri: REDIRECT })
    expect(actor).toEqual({ providerId: 'feishu', tenantId: 't-1', subjectId: 'ou_1', displayName: 'Alice', avatarUrl: 'https://img/a.png' })
  })

  it('sends app_id and app_secret in the token request', async () => {
    const { fetch, calls } = routed({
      'https://open.feishu.example/open-apis/authen/v2/oauth/token': () => jsonResponse({ code: 0, data: { access_token: 'u-abc' } }),
      'https://open.feishu.example/open-apis/authen/v1/user_info': () => jsonResponse({ code: 0, data: { open_id: 'ou_1', tenant_key: 't-1', name: 'Alice' } }),
    })
    const p = await adapter(fetch)
    await p.exchange({ code: 'code-1', state: 'state-1', redirectUri: REDIRECT })
    const tokenCall = calls.find(call => call.url.endsWith('/oauth/token'))
    if (typeof tokenCall?.init.body !== 'string') throw new Error('token request body is not text')
    const body = JSON.parse(tokenCall.init.body) as Record<string, unknown>
    expect(body).toMatchObject({ grant_type: 'authorization_code', client_id: APP_ID, client_secret: APP_SECRET, code: 'code-1', redirect_uri: REDIRECT })
  })

  it('refuses a nonzero token code', async () => {
    const { fetch } = routed({ 'https://open.feishu.example/open-apis/authen/v2/oauth/token': () => jsonResponse({ code: 40001, msg: 'bad' }) })
    const p = await adapter(fetch)
    const error = await p.exchange({ code: 'c', state: 's', redirectUri: REDIRECT }).then(() => undefined, (e: unknown) => e)
    expect(isFeishuProviderError(error)).toBe(true)
    expect((error as { code: string }).code).toBe(INVALID_TOKEN_RESPONSE)
  })

  it('refuses a user-info response without open_id', async () => {
    const { fetch } = routed({
      'https://open.feishu.example/open-apis/authen/v2/oauth/token': () => jsonResponse({ code: 0, data: { access_token: 'u-abc' } }),
      'https://open.feishu.example/open-apis/authen/v1/user_info': () => jsonResponse({ code: 0, data: { name: 'NoOpenId' } }),
    })
    const p = await adapter(fetch)
    const error = await p.exchange({ code: 'c', state: 's', redirectUri: REDIRECT }).then(() => undefined, (e: unknown) => e)
    expect((error as { code: string }).code).toBe(INVALID_USER_INFO)
  })

  it('falls back to defaultTenant when the user has no tenant key', async () => {
    const { fetch } = routed({
      'https://open.feishu.example/open-apis/authen/v2/oauth/token': () => jsonResponse({ code: 0, data: { access_token: 'u-abc' } }),
      'https://open.feishu.example/open-apis/authen/v1/user_info': () => jsonResponse({ code: 0, data: { open_id: 'ou_1', name: 'Alice' } }),
    })
    const p = await adapter(fetch, { defaultTenant: 'fallback' })
    const actor = await p.exchange({ code: 'c', state: 's', redirectUri: REDIRECT })
    expect(actor.tenantId).toBe('fallback')
  })
})
