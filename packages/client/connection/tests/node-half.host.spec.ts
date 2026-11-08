/** Node half: registers the /api prefix route bridging to the api gateway. */
import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { IndexInjection, WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IdentityProvider } from '@deepseek-ai/dsh-identity-protocol'
// The deterministic provider is a package-internal fixture, not public API.
import { MockIdentityProvider } from '../../../identity/identity-protocol/src/mock.ts'
import type { BrowserSessionRecord } from '../src/index.ts'
import {
  API_PATH,
  CONNECT_PATH,
  LOGIN_CALLBACK_PATH,
  LOGIN_PATH,
  LOGOUT_PATH,
  PENDING_LOGIN_LIFETIME_MILLISECONDS,
  PendingLogins,
  RpcId,
  apply,
  inject,
  type ClientRequest,
  type ConnectionConfig,
  type HostConnectionHandle,
  type PeerScope,
} from '../src/index.ts'
import { DEFAULT_MAX_REQUEST_BODY_BYTES } from '../src/http-bridge.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

/** The Peer an index render speaks for; this listener reads no field of it. */
const PAGE_PEER = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]

/** Structural webServer fake recording both route registries. */
function fakeHttpServer(
  routes: WebRoute[],
  upgrades: WebUpgradeRoute[],
  host = '127.0.0.1',
  protocol: WebServer['protocol'] = 'http:',
): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port' | 'host' | 'protocol'> {
  return {
    host,
    protocol,
    register(route: WebRoute) {
      if (routes.some(candidate => candidate.kind === route.kind && candidate.path === route.path)) {
        throw new Error(`duplicate route ${route.path}`)
      }
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

/** Bodyless GET carrying the given headers (enough for the trust fence + bridge). */
function fakeRequest(headers: Record<string, string>, url = `${API_PATH}/session.list`): IncomingMessage {
  const request = Readable.from([]) as IncomingMessage
  Object.assign(request, { url, method: 'GET', headers })
  return request
}

/** JSON POST carrying a complete client-request envelope. */
function fakePost(headers: Record<string, string>, url: string, body: unknown): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers: { 'content-type': 'application/json', ...headers } })
  return request
}

/** Raw POST for malformed-body and media-type boundary cases. */
function fakeRawPost(headers: Record<string, string>, url: string, body: string): IncomingMessage {
  const request = Readable.from([Buffer.from(body)]) as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers })
  return request
}

/** Response recorder compatible with both the fence's short-circuit and the bridge. */
function fakeResponse(): {
  response: ServerResponse
  state: { status?: number; headers?: Record<string, string>; body?: unknown }
} {
  const state: { status?: number; headers?: Record<string, string>; body?: unknown } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number, headers?: Record<string, string>) {
      state.status = value
      if (headers !== undefined) state.headers = headers
      return this
    },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
      else if (value !== undefined) throw new TypeError('fake response only accepts string or Uint8Array bodies')
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

/** In-memory browser-session table standing in for the mounted storage-domain facility. */
class FakeSessionTable {
  private readonly records = new Map<string, BrowserSessionRecord>()

  get(key: string): BrowserSessionRecord | undefined { return this.records.get(key) }

  async put(key: string, value: BrowserSessionRecord): Promise<void> { this.records.set(key, value) }

  async delete(key: string): Promise<boolean> { return this.records.delete(key) }

  /** Every persisted record, in insertion order. */
  entries(): readonly (readonly [string, BrowserSessionRecord])[] { return [...this.records.entries()] }

  /** The domain handle Connection opens and closes around this table. */
  domain(): { table(name: string): FakeSessionTable; close(): Promise<void> } {
    return { table: () => this, close: async () => {} }
  }
}

/**
 * Provide the browser-session domain facility in memory: Connection opens the
 * `sessions` table during apply and reads it back on admission.
 */
function provideSessionDomain(ctx: Context): FakeSessionTable {
  const table = new FakeSessionTable()
  ctx.provide('storageDomain', { open: async () => table.domain() } as never)
  return table
}

async function mounted(
  config?: ConnectionConfig,
  protocol: WebServer['protocol'] = 'http:',
  credentials?: CredentialProvider,
  providers?: IdentityProviderRegistry,
): Promise<{
  ctx: Context
  routes: WebRoute[]
  upgrades: WebUpgradeRoute[]
  connection: HostConnectionHandle
  sessions: FakeSessionTable
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  const sessions = provideSessionDomain(ctx)
  if (credentials === undefined) provideBrowserCredentials(ctx)
  else ctx.provide('credentials', credentials)
  if (providers !== undefined) ctx.provide('identityProviders', providers as never)
  ctx.provide('webServer', fakeHttpServer(routes, upgrades, '127.0.0.1', protocol) as WebServer)
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return {
    ctx,
    routes,
    upgrades,
    connection: ctx.get('connection') as HostConnectionHandle,
    sessions,
    dispose: () => fiber.dispose(),
  }
}

/** Resolve registered adapters the way the identity-provider service does. */
interface IdentityProviderRegistry {
  list(): readonly string[]
  get(id: string): IdentityProvider | undefined
}

/** Registry fake over fixed adapters: insertion order decides the listing. */
function registry(...adapters: IdentityProvider[]): IdentityProviderRegistry {
  return {
    list: () => adapters.map(adapter => adapter.id),
    get: id => adapters.find(adapter => adapter.id === id),
  }
}

/** Exchange a service's process token for one authority-bound Cookie header. */
function browserCookie(connection: HostConnectionHandle, authority: string): string {
  const url = new URL(connection.authenticatedUrl(`http://${authority}`))
  const exchanged = fakeResponse()
  connection.authorizeIndex(
    fakeRequest({ host: authority }, `${url.pathname}${url.search}`),
    exchanged.response,
  )
  const setCookie = exchanged.state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('browser token exchange did not set a cookie')
  return setCookie.split(';', 1)[0]!
}

describe('connection node half', () => {
  it('runs request admission after authentication and removes it with its owning fiber', async () => {
    const { ctx, routes, connection, dispose } = await mounted()
    let admitted = 0
    const guard = ctx.plugin({ apply(owner: Context) {
      owner.on('connection/request', async (_request, response) => {
        admitted++
        response.writeHead(503)
        response.end()
      })
    } })
    try {
      await guard.await()
      const unauthorized = fakeResponse()
      await routes[0]!.handler(fakeRequest({ host: 'localhost' }), unauthorized.response)
      expect(unauthorized.state.status).toBe(401)
      expect(admitted).toBe(0)
      const headers = { host: 'localhost', cookie: browserCookie(connection, 'localhost') }
      const refused = fakeResponse()
      await routes[0]!.handler(fakeRequest(headers), refused.response)
      expect(refused.state.status).toBe(503)
      expect(admitted).toBe(1)
      await guard.dispose()
      const allowed = fakeResponse()
      await routes[0]!.handler(fakeRequest(headers), allowed.response)
      expect(allowed.state.status).toBe(404)
      expect(admitted).toBe(1)
    } finally { await guard.dispose(); await dispose() }
  })

  it('awaits delegated response transfer before releasing the admission listener', async () => {
    const { ctx, routes, connection, dispose } = await mounted()
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    let completed = false
    connection.fetch.register({ path: '/api/held', methods: ['GET'], requestBody: 'buffered',
      async fetch() {
        return new Response(new ReadableStream({ async start(controller) {
          entered.resolve(undefined)
          await finish.promise
          controller.close()
        } }))
      },
    })
    const remove = ctx.on('connection/request', async (_request, _response, next) => {
      await next()
      completed = true
    })
    const response = fakeResponse()
    const pending = routes[0]!.handler(fakeRequest({ host: 'localhost', cookie: browserCookie(connection, 'localhost') }, '/api/held'), response.response)
    try {
      await entered.promise
      expect(completed).toBe(false)
      finish.resolve(undefined)
      await pending
      expect(completed).toBe(true)
    } finally { finish.resolve(undefined); await pending; remove(); await dispose() }
  })

  it('provides the carrier-neutral service without a Web server', async () => {
    const ctx = new Context()
    provideSessionDomain(ctx)
    provideBrowserCredentials(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    try {
      await fiber.await()
      const connection = ctx.get('connection') as HostConnectionHandle
      const cookie = browserCookie(connection, 'localhost')
      expect(connection.admit(fakeRequest({ host: 'localhost', cookie }))).toEqual({ peer: connection.browserPeer })
    } finally {
      await fiber.dispose()
    }
  })

  it('accepts the bind address of a web carrier attached after Connection', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    const upgrades: WebUpgradeRoute[] = []
    provideSessionDomain(ctx)
    provideBrowserCredentials(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    try {
      await fiber.await()
      const connection = ctx.get('connection') as HostConnectionHandle
      const web = ctx.plugin((webCtx) => {
        webCtx.provide('webServer', fakeHttpServer(routes, upgrades, '10.1.2.3') as WebServer)
      })
      try {
        await web.await()
        await expect.poll(() => routes.find(route => route.path === API_PATH)).toBeDefined()
        const bound = browserCookie(connection, '10.1.2.3:3080')
        expect(connection.requestRejection(fakeRequest({ host: '10.1.2.3:3080', cookie: bound }))).toBeUndefined()
      } finally {
        await web.dispose()
      }
    } finally {
      await fiber.dispose()
    }
  })

  it('uses the TLS default port for markerless exact-authority grants', async () => {
    const { connection, dispose } = await mounted({ trustedHosts: ['tls.example:443', 'plain.example:80'] }, 'https:')
    try {
      expect(connection.requestRejection(fakeRequest({ host: 'tls.example' }))).toBe(401)
      expect(connection.requestRejection(fakeRequest({ host: 'plain.example' }))).toBe(403)
      expect(connection.requestRejection(fakeRequest({ host: 'tls.example:444' }))).toBe(403)
    } finally {
      await dispose()
    }
  })

  it('marks the minted browser cookie Secure from the mounted listener protocol', async () => {
    for (const [protocol, secure] of [['http:', false], ['https:', true]] as const) {
      const { connection, dispose } = await mounted(undefined, protocol)
      try {
        const url = new URL(connection.authenticatedUrl('http://127.0.0.1:3080'))
        const exchanged = fakeResponse()
        connection.authorizeIndex(
          fakeRequest({ host: '127.0.0.1:3080', 'x-forwarded-proto': secure ? 'http' : 'https' }, `${url.pathname}${url.search}`),
          exchanged.response,
        )
        const setCookie = exchanged.state.headers?.['set-cookie']
        expect(setCookie?.endsWith('; Secure'), protocol).toBe(secure)
        if (setCookie === undefined) throw new Error('browser token exchange did not set a cookie')
        expect(connection.requestRejection(fakeRequest({
          host: '127.0.0.1:3080',
          cookie: setCookie.split(';', 1)[0]!,
        }))).toBeUndefined()
      } finally {
        await dispose()
      }
    }
  })

  it('injects validated browser recovery timing and withdraws it on disposal', async () => {
    const { ctx, dispose } = await mounted({ recovery: { generationReadyTimeoutMs: 25_000 } })
    try {
      const rows: IndexInjection[] = []
      ctx.emit('webserver/index-inject', rows, PAGE_PEER)
      expect(rows).toEqual([{
        kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: {
          backoffBaseMs: 500, backoffFactor: 2, backoffMaxMs: 10_000,
          generationReadyWarnMs: 3_000, generationReadyTimeoutMs: 25_000,
        },
      }])
      await dispose()
      const after: IndexInjection[] = []
      ctx.emit('webserver/index-inject', after, PAGE_PEER)
      expect(after).toEqual([])
    } finally {
      await dispose()
    }
  })

  it.each([
    { recovery: { backoffBaseMs: 0 }, error: /backoffBaseMs/ },
    { recovery: { backoffFactor: NaN }, error: /backoffFactor.*finite/ },
  ])('rejects invalid recovery timing before acquiring Host resources: $recovery', async ({ recovery, error }) => {
    const ctx = new Context()
    await expect(apply(ctx, { recovery })).rejects.toThrow(error)
    expect(ctx.get('connection')).toBeUndefined()
  })

  it('reports allowsRemoteAuthorities from validated trustedHosts only', async () => {
    const cases: { trustedHosts: string[]; expected: boolean }[] = [
      { trustedHosts: ['127.0.0.1', 'localhost', '[::1]'], expected: false },
      { trustedHosts: ['harness.example'], expected: true },
      { trustedHosts: ['127.0.0.1', 'harness.example'], expected: true },
    ]
    for (const { trustedHosts, expected } of cases) {
      const deployment = await mounted({ trustedHosts })
      try {
        expect(deployment.connection.allowsRemoteAuthorities, trustedHosts.join(',')).toBe(expected)
      } finally {
        await deployment.dispose()
      }
    }
  })

  it('reserves enough default carrier capacity for the 200 MiB image batch', () => {
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBe(300 * 1024 * 1024)
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBeGreaterThan(Math.ceil(200 * 1024 * 1024 * 4 / 3) + 1024 * 1024)
  })

  it('fails loud when the carrier cap cannot hold the configured image batch', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('attachments', {
      imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
    } as AttachmentStore)
    await expect(apply(ctx, { maxRequestBodyBytes: 1024 }))
      .rejects.toThrow(/must be at least .* aggregate image limit/)
    expect(routes).toHaveLength(0)
  })

  it('fails the load on a trustedHosts entry that is not a bare authority', async () => {
    const routes: WebRoute[] = []
    const upgrades: WebUpgradeRoute[] = []
    const ctx = new Context()
    provideSessionDomain(ctx)
    provideBrowserCredentials(ctx)
    ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.internal/path'] })
    await expect(fiber).rejects.toThrow(/not a bare host\[:port\] authority/)
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('registers the API, connect, and login HTTP routes and removes them with the fiber', async () => {
    const { routes, upgrades, dispose } = await mounted()
    expect(routes.map(route => route.path)).toEqual([API_PATH, CONNECT_PATH, LOGIN_PATH, LOGIN_CALLBACK_PATH, LOGOUT_PATH])
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })
    expect(upgrades).toHaveLength(0)
    await dispose()
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('refuses an untrusted Host on any /api path before the bridge runs', async () => {
    const { routes, dispose } = await mounted()
    const { response, state } = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }), response)
    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
    await dispose()
  })

  it('requires the same browser session for every method on every trusted authority', async () => {
    const { routes, connection, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    const methods = [
      'session/openWorkspacePath',
      'llm/discoverModels', 'skills/list', 'agentPresets/list',
    ]
    for (const method of methods) {
      const denied = fakeResponse()
      await routes[0]!.handler(fakeRequest({ host: 'harness.example' }, `${API_PATH}/${method}`), denied.response)
      expect([method, denied.state.status, denied.state.body]).toEqual([method, 401, 'unauthorized'])
    }

    const cookie = browserCookie(connection, 'harness.example')
    for (const method of methods) {
      const allowed = fakeResponse()
      await routes[0]!.handler(
        fakeRequest({ host: 'harness.example', cookie }, `${API_PATH}/${method}`),
        allowed.response,
      )
      expect([method, allowed.state.status]).toEqual([method, 404])
    }

    const forged = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: 'localhost:3080' }), forged.response)
    expect(forged.state).toMatchObject({ status: 401, body: 'unauthorized' })
    await dispose()
  })

  it('passes loopback and declared-authority requests through to the bridge', async () => {
    const { routes, connection, dispose } = await mounted({ trustedHosts: ['harness.example:3080', '192.168.1.5'] })
    // Loopback, no browser markers (curl shape): the fence passes; the carrier
    // answers 404 for a GET unary path — proof the bridge ran.
    const loopback = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: '127.0.0.1:3080',
      cookie: browserCookie(connection, '127.0.0.1:3080'),
    }), loopback.response)
    expect(loopback.state.status).toBe(404)
    const lan = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: '192.168.1.5:3080',
      cookie: browserCookie(connection, '192.168.1.5:3080'),
    }), lan.response)
    expect(lan.state.status).toBe(404)
    // Declared public authority, same-origin browser shape.
    const declared = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example:3080',
      origin: 'http://harness.example:3080',
      'sec-fetch-site': 'same-origin',
      cookie: browserCookie(connection, 'harness.example:3080'),
    }), declared.response)
    expect(declared.state.status).toBe(404)
    await dispose()
  })

  it('shares its configured trust and authentication policy with sibling routes', async () => {
    const { connection, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    const loopback = fakeRequest({ host: '127.0.0.1:3080' })
    const declared = fakeRequest({ host: 'harness.example' })

    expect(connection.requestRejection(loopback)).toBe(401)
    expect(connection.requestRejection(declared)).toBe(401)
    expect(connection.requestRejection(fakeRequest({
      host: 'harness.example',
      cookie: browserCookie(connection, 'harness.example'),
    }))).toBeUndefined()
    await dispose()
  })

  it('provides a disposable dedicated RPC channel', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    provideSessionDomain(ctx)
    provideBrowserCredentials(ctx)
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(routes).toHaveLength(5)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })

    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    const remove = connection.rpc.handle('/rpc', async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { accepted: true } }
    })
    const route = routes.find(candidate => candidate.path === '/rpc')
    expect(route).toBeDefined()

    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-dedicated'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }
    const result = fakeResponse()
    await route!.handler(fakePost({
      host: '127.0.0.1:3080',
      cookie: browserCookie(connection, '127.0.0.1:3080'),
    }, '/rpc/goals/create', request), result.response)
    expect(result.state.status).toBe(200)
    expect(JSON.parse(String(result.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-dedicated',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])

    expect(() => connection.rpc.handle('/rpc', async () => ({ ok: true, value: null })))
      .toThrow(/duplicate route/)
    await remove()
    expect(routes.map(candidate => candidate.path)).toEqual([API_PATH, '/connect', LOGIN_PATH, LOGIN_CALLBACK_PATH, LOGOUT_PATH])
    await fiber.dispose()
    expect(routes).toHaveLength(0)
  })

  it('dispatches claimed /api endpoints and withdraws the claim', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    provideSessionDomain(ctx)
    provideBrowserCredentials(ctx)
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    const remove = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async (endpoint, payload) => {
        calls.push({ endpoint, payload })
        return { ok: true, value: { accepted: true } }
      },
    )
    expect(() => connection.rpc.intercept(
      '/api',
      () => true,
      async () => ({ ok: true, value: null }),
    )).toThrow('already has an interceptor')
    expect(() => connection.rpc.intercept(
      '/rpc' as '/api',
      () => true,
      async () => ({ ok: true, value: null }),
    )).toThrow('invalid shared RPC channel')
    const route = routes.find(candidate => candidate.path === API_PATH)!
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-shared'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }

    const claimed = fakeResponse()
    const loopbackCookie = browserCookie(connection, '127.0.0.1:3080')
    await route.handler(fakePost({
      host: '127.0.0.1:3080', cookie: loopbackCookie,
    }, '/api/goals/create', request), claimed.response)
    expect(JSON.parse(String(claimed.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-shared',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/api/goals/create', request), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })
    expect(calls).toHaveLength(1)

    const unclaimed = fakeResponse()
    await route.handler(fakeRequest({
      host: '127.0.0.1:3080', cookie: loopbackCookie,
    }, '/api/session.list'), unclaimed.response)
    expect(unclaimed.state.status).toBe(404)

    await remove()
    const withdrawn = fakeResponse()
    await route.handler(fakePost({
      host: '127.0.0.1:3080', cookie: loopbackCookie,
    }, '/api/goals/create', request), withdrawn.response)
    expect(withdrawn.state.status).toBe(404)
    expect(calls).toHaveLength(1)

    const removeAuthenticated = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async () => ({ ok: true, value: null }),
    )
    const declared = fakeResponse()
    await route.handler(fakePost({
      host: 'harness.example',
      cookie: browserCookie(connection, 'harness.example'),
    }, '/api/goals/create', request), declared.response)
    expect(declared.state.status).toBe(200)
    await removeAuthenticated()
    await fiber.dispose()
  })

  it('admits every trusted, authenticated request as the owner browser Peer and hands each call that Peer', async () => {
    const { connection, routes, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    const peers: PeerScope[] = []
    const remove = connection.rpc.intercept(
      '/api',
      () => true,
      async (_endpoint, _payload, _signal, peer) => {
        peers.push(peer)
        return { ok: true, value: null }
      },
    )
    expect(connection.admit(fakeRequest({ host: 'other.example' }))).toEqual({ rejection: 403 })
    expect(connection.admit(fakeRequest({ host: '127.0.0.1:3080' }))).toEqual({ rejection: 401 })
    const cookie = browserCookie(connection, '127.0.0.1:3080')
    expect(connection.admit(fakeRequest({ host: '127.0.0.1:3080', cookie }))).toEqual({ peer: connection.browserPeer })

    const route = routes.find(candidate => candidate.path === API_PATH)!
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-peer'),
      method: 'goals/create',
      payload: { args: {} },
    }
    const answered = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080', cookie }, '/api/goals/create', request), answered.response)
    expect(JSON.parse(String(answered.state.body))).toMatchObject({ result: { ok: true, value: null } })
    // A shell-owned carrier dispatches the shared handler without the bridge and speaks for the browser Peer too.
    const direct = await connection.createSharedFetchHandler('/api').fetch(new Request('http://127.0.0.1:3080/api/goals/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }), connection.browserPeer)
    expect(direct.status).toBe(200)
    expect(peers).toEqual([connection.browserPeer, connection.browserPeer])
    expect(connection.browserPeer.principal).toEqual({ kind: 'owner' })

    // Racing disposals share one completion, and the scope goes with the Connection.
    await Promise.all([connection.browserPeer.dispose(), connection.browserPeer.dispose()])
    await remove()
    await dispose()
  })

  it('applies the configured trust fence and JSON envelope checks to generic channels', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    provideSessionDomain(ctx)
    provideBrowserCredentials(ctx)
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const remove = connection.rpc.handle('/rpc', async (endpoint) => {
      if (endpoint === 'fail') throw new Error('handler broke')
      return { ok: true, value: null }
    })
    const route = routes.find(candidate => candidate.path === '/rpc')!
    const harnessHeaders = {
      host: 'harness.example',
      cookie: browserCookie(connection, 'harness.example'),
    }

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/rpc/goals/create', {}), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })

    const unauthenticated = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/rpc/goals/create', {}), unauthenticated.response)
    expect(unauthenticated.state).toMatchObject({ status: 401, body: 'unauthorized' })

    const methodMismatch = fakeResponse()
    await route.handler(fakePost(harnessHeaders, '/rpc/goals/create', {
      type: 'client-request', rpcId: 'rpc-bad', method: 'other', payload: {},
    }), methodMismatch.response)
    expect(JSON.parse(String(methodMismatch.state.body))).toMatchObject({
      rpcId: 'rpc-bad',
      result: { ok: false, error: { code: 'gateway/bad-request' } },
    })

    for (const [request, status] of [
      [fakeRequest(harnessHeaders, '/rpc/goals/create'), 404],
      [fakePost(harnessHeaders, '/outside/goals/create', {}), 404],
      [fakePost(harnessHeaders, '/rpc/goals//create', {}), 404],
      [fakeRawPost(harnessHeaders, '/rpc/goals/create', '{}'), 415],
      [fakeRawPost({ ...harnessHeaders, 'content-type': 'text/plain' }, '/rpc/goals/create', '{}'), 415],
      [fakeRawPost({ ...harnessHeaders, 'content-type': 'application/json; charset=utf-8' }, '/rpc/goals/create', '{'), 400],
    ] as const) {
      const response = fakeResponse()
      await route.handler(request, response.response)
      expect(response.state.status).toBe(status)
    }

    for (const [body, rpcId] of [
      [{ rpcId: 'retained-id' }, 'retained-id'],
      [{ rpcId: 42 }, 'invalid-request'],
      [null, 'invalid-request'],
    ] as const) {
      const response = fakeResponse()
      await route.handler(fakePost(harnessHeaders, '/rpc/goals/create', body), response.response)
      expect(JSON.parse(String(response.state.body))).toMatchObject({
        rpcId,
        result: { ok: false, error: { code: 'gateway/bad-request' } },
      })
    }

    const failed = fakeResponse()
    await route.handler(fakePost(harnessHeaders, '/rpc/fail', {
      type: 'client-request', rpcId: 'rpc-fail', method: 'fail', payload: {},
    }), failed.response)
    expect(failed.state).toMatchObject({ status: 500, body: 'handler failure: Error: handler broke' })

    expect(() => connection.rpc.handle('/api', async () => ({ ok: true, value: null })))
      .toThrow('invalid or reserved RPC channel')
    expect(() => connection.rpc.handle('api3', async () => ({ ok: true, value: null })))
      .toThrow('invalid or reserved RPC channel')
    await remove()
    await fiber.dispose()
  })
})

describe('operator-scoped connect', () => {
  async function connect(
    host: Awaited<ReturnType<typeof mounted>>,
    query = '',
    headers: Record<string, string> = {},
  ): Promise<{ cookie: string; state: ReturnType<typeof fakeResponse>['state'] }> {
    const token = new URL(host.connection.authenticatedUrl('http://localhost')).search
    const response = fakeResponse()
    await host.routes.find(route => route.path === '/connect')!.handler(
      fakeRequest({ host: 'localhost', ...headers }, `/connect${token}${query}`), response.response,
    )
    return { cookie: response.state.headers?.['set-cookie']?.split(';', 1)[0] ?? '', state: response.state }
  }

  function admitted(connection: HostConnectionHandle, cookie: string): PeerScope {
    const admission = connection.admit(fakeRequest({ host: 'localhost', cookie }))
    if ('rejection' in admission) throw new Error(`operator refused: ${admission.rejection}`)
    return admission.peer
  }

  it('defaults API callers to none regardless of Accept and honors explicit declarations', async () => {
    const host = await mounted()
    try {
      for (const [query, headers, interactions, status, location] of [
        ['', {}, 'none', 302, './api/remote.mux'],
        ['&interactions=none', {}, 'none', 302, './api/remote.mux'],
        ['&interactions=answer', {}, 'answer', 302, './api/remote.mux'],
        ['', { accept: 'text/html,application/xhtml+xml' }, 'none', 302, './api/remote.mux'],
        ['&interactions=answer', { accept: 'text/html' }, 'answer', 302, './api/remote.mux'],
      ] as const) {
        const result = await connect(host, query, headers)
        expect(result.state).toMatchObject({ status, headers: { location, 'cache-control': 'no-store' } })
        expect(admitted(host.connection, result.cookie).interactions).toBe(interactions)
      }
      const rootCookie = browserCookie(host.connection, 'localhost')
      expect(admitted(host.connection, rootCookie).interactions).toBe('answer')
    } finally { await host.dispose() }
  })

  it('keeps all browser cookies on the shared operator and creates independent API operators', async () => {
    const host = await mounted()
    try {
      const cookie = browserCookie(host.connection, 'localhost')
      expect(admitted(host.connection, cookie)).toBe(host.connection.browserPeer)
      expect(admitted(host.connection, browserCookie(host.connection, 'localhost'))).toBe(host.connection.browserPeer)
      const api = await connect(host, '', { cookie })
      expect(admitted(host.connection, api.cookie)).not.toBe(host.connection.browserPeer)
      const second = await connect(host, '', { cookie: api.cookie })
      expect(admitted(host.connection, second.cookie)).not.toBe(admitted(host.connection, api.cookie))
      const denied = fakeResponse()
      expect(host.connection.authorizeIndex(fakeRequest(
        { host: 'localhost', cookie: api.cookie }, '/',
      ), denied.response)).toBeUndefined()
      expect(denied.state.status).toBe(401)
    } finally { await host.dispose() }
  })

  it('refuses invalid declarations, authentication, and untrusted connect requests without a cookie', async () => {
    const host = await mounted()
    try {
      for (const query of ['&interactions=observe', '&interactions=', '&interactions=none&interactions=answer']) {
        const result = await connect(host, query)
        expect(result.state.status).toBe(400)
        expect(result.cookie).toBe('')
      }
      for (const headers of [{ host: 'untrusted.example' }, { origin: 'http://untrusted.example' }]) {
        expect((await connect(host, '', headers)).state.status).toBe(403)
      }
      const route = host.routes.find(route => route.path === '/connect')!
      for (const request of [
        fakeRequest({ host: 'localhost' }, '/connect?token=invalid'),
        fakePost({ host: 'localhost' }, '/connect', {}),
      ]) {
        const response = fakeResponse()
        await route.handler(request, response.response)
        expect(response.state.status).toBe(401)
        expect(response.state.headers?.['set-cookie']).toBeUndefined()
      }
    } finally { await host.dispose() }
  })

  it('refuses a captured connect request after the owning fiber is disposed', async () => {
    const host = await mounted()
    try {
      const route = host.routes.find(candidate => candidate.path === '/connect')!
      const request = fakeRequest({ host: 'localhost' }, host.connection.authenticatedUrl('http://localhost/connect'))
      await host.dispose()
      const response = fakeResponse()

      await route.handler(request, response.response)

      expect(response.state).toEqual({ status: 401, body: 'unauthorized' })
      expect(response.response.writableEnded).toBe(true)
    } finally { await host.dispose() }
  })

  it('dispatches HTTP before a socket and lets an admitted call finish after socket release', async () => {
    const host = await mounted()
    const finish = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<AbortSignal>()
    try {
      const first = await connect(host)
      const second = await connect(host)
      const peer = admitted(host.connection, first.cookie)
      expect(admitted(host.connection, second.cookie).id).not.toBe(peer.id)
      host.connection.rpc.intercept('/api', () => true, async (_endpoint, _payload, signal, caller) => {
        expect(caller).toBe(peer)
        if (_endpoint === 'fixture/held') {
          started.resolve(signal)
          await finish.promise
        }
        return { ok: true, value: { id: caller.id } }
      })
      const api = host.routes.find(route => route.path === '/api')!
      const post = (method: string): IncomingMessage => fakePost({ host: 'localhost', cookie: first.cookie }, `/api/${method}`, {
        type: 'client-request', rpcId: 'connect-test', method, payload: {},
      })
      const beforeSocket = fakeResponse()
      await api.handler(post('fixture/now'), beforeSocket.response)
      expect(JSON.parse(String(beforeSocket.state.body))).toMatchObject({ result: { ok: true, value: { id: peer.id } } })

      const pendingResponse = fakeResponse()
      const pending = api.handler(post('fixture/held'), pendingResponse.response)
      const signal = await started.promise
      const owner = host.connection.admitConnection(fakeRequest({ host: 'localhost', cookie: first.cookie }))
      if ('rejection' in owner) throw new Error('first socket was refused')
      expect(owner.peer).toBe(peer)
      expect(host.connection.admitConnection(fakeRequest({ host: 'localhost', cookie: first.cookie })))
        .toEqual({ rejection: 409 })
      expect(admitted(host.connection, first.cookie)).toBe(peer)
      const cleanup = vi.fn()
      peer.ctx.effect(() => cleanup)
      const released = owner.release()
      expect(host.connection.admit(fakeRequest({ host: 'localhost', cookie: first.cookie }))).toEqual({ rejection: 401 })
      expect(owner.release()).toBe(released)
      await released
      expect(cleanup).toHaveBeenCalledOnce()
      expect(signal.aborted).toBe(false)
      finish.resolve(undefined)
      await pending
      expect(pendingResponse.state.status).toBe(200)
      const afterSocket = fakeResponse()
      await api.handler(post('fixture/now'), afterSocket.response)
      expect(afterSocket.state.status).toBe(401)
      expect(host.connection.admitConnection(fakeRequest({ host: 'localhost', cookie: first.cookie })))
        .toEqual({ rejection: 401 })
    } finally { finish.resolve(undefined); await host.dispose() }
  })

  it('retains unused operators for arbitrary elapsed time but rejects expired cookies', async () => {
    const host = await mounted({ cookieMaxAgeDays: 36_500 })
    vi.useFakeTimers()
    try {
      const { cookie } = await connect(host)
      const peer = admitted(host.connection, cookie)
      await vi.advanceTimersByTimeAsync(10 * 365 * 86_400_000)
      expect(admitted(host.connection, cookie)).toBe(peer)
      const disposed = vi.fn()
      peer.ctx.effect(() => disposed)
      await vi.advanceTimersByTimeAsync(100 * 365 * 86_400_000)
      expect(host.connection.admit(fakeRequest({ host: 'localhost', cookie }))).toEqual({ rejection: 401 })
      expect(disposed).not.toHaveBeenCalled()
      await host.dispose()
      expect(disposed).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers(); await host.dispose() }
  })

  it('preserves browser tabs and restart recovery without resurrecting API operators', async () => {
    const host = await mounted()
    const browser = { cookie: browserCookie(host.connection, 'localhost') }
    const api = await connect(host)
    const browserPeer = admitted(host.connection, browser.cookie)
    try {
      const request = fakeRequest({ host: 'localhost', cookie: browser.cookie })
      const one = host.connection.admitConnection(request)
      const two = host.connection.admitConnection(request)
      if ('rejection' in one || 'rejection' in two) throw new Error('browser tab was refused')
      expect(two.peer).toBe(one.peer)
      await one.release()
      expect(admitted(host.connection, browser.cookie)).toBe(browserPeer)
      await two.release()
      expect(admitted(host.connection, browser.cookie)).toBe(browserPeer)
      const refresh = fakeResponse()
      expect(host.connection.authorizeIndex(fakeRequest({ host: 'localhost', cookie: browser.cookie }, '/'), refresh.response)).toBe(host.connection.browserPeer)
      const cleanup = vi.fn()
      browserPeer.ctx.effect(() => cleanup)
      await host.dispose()
      expect(cleanup).toHaveBeenCalledOnce()
      expect(host.connection.admit(request)).toEqual({ rejection: 401 })
      const restarted = await mounted(undefined, 'http:', host.ctx.credentials)
      try {
        expect(admitted(restarted.connection, browser.cookie)).toBe(restarted.connection.browserPeer)
        expect(admitted(restarted.connection, browser.cookie)).not.toBe(browserPeer)
        expect(restarted.connection.admit(fakeRequest({ host: 'localhost', cookie: api.cookie }))).toEqual({ rejection: 401 })
      } finally { await restarted.dispose() }
    } finally { await host.dispose() }
  })
})

describe('connection node half over a real HTTP server', () => {
  /** Serve the registered prefix route from a real server and return its port. */
  async function serve(routes: WebRoute[]): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((request, response) => {
      void routes[0]!.handler(request, response)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    return {
      port: address.port,
      close: () => new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) resolve()
          else reject(error)
        })
      }),
    }
  }

  /** One real request; `host` spoofs the authority the way a LAN client's browser would send it. */
  function call(port: number, method: string, host: string, cookie?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: `${API_PATH}/${method}`,
          method: 'GET',
          headers: { host, ...cookie === undefined ? {} : { cookie } },
        },
        (response) => {
          response.resume()
          response.on('end', () => { resolve(response.statusCode ?? 0) })
        },
      )
      request.on('error', reject)
      request.end()
    })
  }

  it('requires authentication uniformly over a real HTTP request', async () => {
    // A real IncomingMessage pins the exploit boundary: a client-controlled
    // Host naming loopback passes the rebinding fence but never authenticates.
    const { routes, connection, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    const { port, close } = await serve(routes)
    try {
      const methods = [
        'settings/openSettingsDocument',
        'session/openWorkspacePath',
        'llm/discoverModels', 'skills/list',
        'agentPresets/list',
        'llm/listProviders', 'session/modelCatalog',
      ]
      for (const method of methods) {
        expect([method, await call(port, method, 'localhost')]).toEqual([method, 401])
        expect([method, await call(port, method, 'harness.example')]).toEqual([method, 401])
      }
      expect(await call(port, 'settings/openSettingsDocument', 'other.example')).toBe(403)

      const declaredCookie = browserCookie(connection, 'harness.example')
      for (const method of methods) {
        expect([method, await call(port, method, 'harness.example', declaredCookie)]).toEqual([method, 404])
      }
      const loopbackAuthority = `127.0.0.1:${String(port)}`
      expect(await call(
        port,
        'settings/openSettingsDocument',
        loopbackAuthority,
        browserCookie(connection, loopbackAuthority),
      )).toBe(404)
    } finally {
      await close()
      await dispose()
    }
  })
})

/** Hosted browser login: /login, /login/callback, and /logout over a session store. */
describe('hosted browser login', () => {
  const alice = new MockIdentityProvider('acme', [{ id: 'alice', tenantId: 'tenant-a', displayName: 'Alice' }])
  const bob = new MockIdentityProvider('globex', [{ id: 'bob', tenantId: 'tenant-b', displayName: 'Bob' }])

  type Host = Awaited<ReturnType<typeof mounted>>

  /** Invoke one registered exact route and record the response it wrote. */
  async function request(
    host: Host,
    path: string,
    headers: Record<string, string>,
    url = path,
  ): Promise<{ status: number | undefined; headers: Record<string, string>; body?: unknown }> {
    const route = host.routes.find(candidate => candidate.path === path)
    if (route === undefined) throw new Error(`route ${path} was not registered`)
    const recorded = fakeResponse()
    await route.handler(fakeRequest(headers, url), recorded.response)
    return { status: recorded.state.status, headers: recorded.state.headers ?? {}, body: recorded.state.body }
  }

  /** Start a login and follow the provider callback its redirect names. */
  async function login(host: Host, query = ''): Promise<{ cookie: string; state: string }> {
    const started = await request(host, LOGIN_PATH, { host: 'localhost' }, `${LOGIN_PATH}${query}`)
    expect(started.status).toBe(303)
    const target = new URL(started.headers['location'] ?? 'http://invalid')
    const finished = await request(host, LOGIN_CALLBACK_PATH, { host: 'localhost' }, `${LOGIN_CALLBACK_PATH}${target.search}`)
    expect(finished.status).toBe(303)
    const setCookie = finished.headers['set-cookie']
    if (setCookie === undefined) throw new Error('login callback did not set a session cookie')
    return { cookie: setCookie.split(';', 1)[0]!, state: target.searchParams.get('state') ?? '' }
  }

  it('sends a launch-token or anonymous index request into the login flow instead of minting an owner cookie', async () => {
    const host = await mounted(undefined, 'http:', undefined, registry(alice))
    try {
      const tokenized = new URL(host.connection.authenticatedUrl('http://localhost'))
      const redirected = fakeResponse()
      expect(host.connection.authorizeIndex(
        fakeRequest({ host: 'localhost' }, `${tokenized.pathname}${tokenized.search}`),
        redirected.response,
      )).toBeUndefined()
      expect(redirected.state).toMatchObject({ status: 303, headers: { location: './login' } })

      const anonymous = fakeResponse()
      expect(host.connection.authorizeIndex(fakeRequest({ host: 'localhost' }, '/'), anonymous.response)).toBeUndefined()
      expect(anonymous.state).toMatchObject({ status: 303, headers: { location: './login' } })
    } finally { await host.dispose() }
  })

  it('returns to the mount root when no provider is registered', async () => {
    const host = await mounted()
    try {
      expect(await request(host, LOGIN_PATH, { host: 'localhost' })).toMatchObject({ status: 303, headers: { location: '../' } })
    } finally { await host.dispose() }
  })

  it('redirects /login to the selected provider and refuses an ambiguous or unknown selection', async () => {
    const single = await mounted(undefined, 'http:', undefined, registry(alice))
    try {
      const started = await request(single, LOGIN_PATH, { host: 'localhost' })
      expect(started.status).toBe(303)
      expect(started.headers['location']).toMatch(/^http:\/\/localhost\/login\/callback\?code=alice&state=/)
    } finally { await single.dispose() }

    const both = await mounted(undefined, 'http:', undefined, registry(alice, bob))
    try {
      const ambiguous = await request(both, LOGIN_PATH, { host: 'localhost' })
      expect(ambiguous.status).toBe(400)
      expect(ambiguous.body).toContain('acme, globex')
      expect((await request(both, LOGIN_PATH, { host: 'localhost' }, `${LOGIN_PATH}?provider=nope`)).status).toBe(400)
      const selected = await request(both, LOGIN_PATH, { host: 'localhost' }, `${LOGIN_PATH}?provider=globex`)
      expect(selected.headers['location']).toContain('code=bob')
    } finally { await both.dispose() }
  })

  it('applies the Host fence to every login route', async () => {
    const host = await mounted({ trustedHosts: ['harness.example'] }, 'http:', undefined, registry(alice))
    try {
      expect((await request(host, LOGIN_PATH, { host: 'evil.example' })).status).toBe(403)
      expect((await request(host, LOGIN_CALLBACK_PATH, { host: 'evil.example' })).status).toBe(403)
      expect((await request(host, LOGOUT_PATH, { host: 'evil.example' })).status).toBe(403)
    } finally { await host.dispose() }
  })

  it('persists one session record per login and admits its user Peer', async () => {
    const host = await mounted(undefined, 'http:', undefined, registry(alice))
    try {
      const { cookie: firstCookie, state } = await login(host)
      const admitted = host.connection.admit(fakeRequest({ host: 'localhost', cookie: firstCookie }))
      if (!('peer' in admitted)) throw new Error('login cookie was refused')
      expect(admitted.peer.principal).toEqual({
        kind: 'user', providerId: 'acme', tenantId: 'tenant-a', subjectId: 'alice', displayName: 'Alice',
      })
      const again = host.connection.admit(fakeRequest({ host: 'localhost', cookie: firstCookie }))
      expect('peer' in again ? again.peer : undefined).toBe(admitted.peer)

      const records = host.sessions.entries()
      expect(records).toHaveLength(1)
      expect(records[0]?.[1]).toMatchObject({ providerId: 'acme', userKey: 'acme:tenant-a:alice', csrf: state })
    } finally { await host.dispose() }
  })

  it('partitions two providers into distinct user Peers', async () => {
    const host = await mounted(undefined, 'http:', undefined, registry(alice, bob))
    try {
      const peers = []
      for (const query of ['?provider=acme', '?provider=globex']) {
        const { cookie } = await login(host, query)
        const admitted = host.connection.admit(fakeRequest({ host: 'localhost', cookie }))
        if (!('peer' in admitted)) throw new Error('login cookie was refused')
        peers.push(admitted.peer)
      }
      expect(peers[0]).not.toBe(peers[1])
      expect(peers[0]?.principal).toMatchObject({ providerId: 'acme', tenantId: 'tenant-a', subjectId: 'alice' })
      expect(peers[1]?.principal).toMatchObject({ providerId: 'globex', tenantId: 'tenant-b', subjectId: 'bob' })
    } finally { await host.dispose() }
  })

  it('renders the index for the logged-in user Peer and refuses a logged-out session', async () => {
    const host = await mounted(undefined, 'http:', undefined, registry(alice))
    try {
      const { cookie } = await login(host)
      const rendered = fakeResponse()
      const peer = host.connection.authorizeIndex(fakeRequest({ host: 'localhost', cookie }, '/'), rendered.response)
      expect(peer?.principal).toMatchObject({ kind: 'user', subjectId: 'alice' })

      const loggedOut = await request(host, LOGOUT_PATH, { host: 'localhost', cookie })
      expect(loggedOut.status).toBe(303)
      expect(loggedOut.headers['set-cookie']).toContain('Max-Age=0')

      const refused = fakeResponse()
      expect(host.connection.authorizeIndex(fakeRequest({ host: 'localhost', cookie }, '/'), refused.response)).toBeUndefined()
      expect(refused.state.status).toBe(401)
      expect(host.connection.admit(fakeRequest({ host: 'localhost', cookie }))).toEqual({ rejection: 401 })
    } finally { await host.dispose() }
  })

  it('redirects a logout without a session cookie and leaves a single-user owner cookie alone', async () => {
    const hosted = await mounted(undefined, 'http:', undefined, registry(alice))
    try {
      const anonymous = await request(hosted, LOGOUT_PATH, { host: 'localhost' })
      expect(anonymous.status).toBe(303)
      expect(anonymous.headers['set-cookie']).toContain('Max-Age=0')
    } finally { await hosted.dispose() }

    const single = await mounted()
    try {
      const ownerCookie = browserCookie(single.connection, 'localhost')
      expect(single.connection.admit(fakeRequest({ host: 'localhost', cookie: ownerCookie }))).toEqual({ peer: single.connection.browserPeer })
    } finally { await single.dispose() }
  })

  it('refuses an unknown, replayed, or unexchangeable callback', async () => {
    const host = await mounted(undefined, 'http:', undefined, registry(alice))
    try {
      expect((await request(host, LOGIN_CALLBACK_PATH, { host: 'localhost' },
        `${LOGIN_CALLBACK_PATH}?code=alice&state=unknown`)).status).toBe(401)

      const { state } = await login(host)
      expect((await request(host, LOGIN_CALLBACK_PATH, { host: 'localhost' },
        `${LOGIN_CALLBACK_PATH}?code=alice&state=${encodeURIComponent(state)}`)).status).toBe(401)

      const started = await request(host, LOGIN_PATH, { host: 'localhost' })
      const pending = new URL(started.headers['location'] ?? 'http://invalid').searchParams.get('state') ?? ''
      expect((await request(host, LOGIN_CALLBACK_PATH, { host: 'localhost' },
        `${LOGIN_CALLBACK_PATH}?code=mallory&state=${encodeURIComponent(pending)}`)).status).toBe(401)
    } finally { await host.dispose() }
  })

  it('refuses an expired session record on admission and on the index', async () => {
    const host = await mounted(undefined, 'http:', undefined, registry(alice))
    try {
      const { cookie } = await login(host)
      const [entry] = host.sessions.entries()
      if (entry === undefined) throw new Error('login did not persist a session record')
      await host.sessions.put(entry[0], { ...entry[1], expiresAt: Date.now() - 1 })
      expect(host.connection.admit(fakeRequest({ host: 'localhost', cookie }))).toEqual({ rejection: 401 })
      const refused = fakeResponse()
      expect(host.connection.authorizeIndex(fakeRequest({ host: 'localhost', cookie }, '/'), refused.response)).toBeUndefined()
      expect(refused.state.status).toBe(401)
    } finally { await host.dispose() }
  })

  it('reports a provider that cannot build its authorization endpoint', async () => {
    const broken: IdentityProvider = {
      id: 'broken',
      scopes: [],
      authorizationUrl() { throw new Error('no endpoint') },
      exchange() { return Promise.reject(new Error('unreachable')) },
    }
    const host = await mounted(undefined, 'http:', undefined, registry(broken))
    try {
      expect((await request(host, LOGIN_PATH, { host: 'localhost' })).status).toBe(502)
    } finally { await host.dispose() }
  })
})

/** Process-local in-flight authorizations behind the login redirect. */
describe('pending browser logins', () => {
  const REDIRECT = 'http://localhost/login/callback'

  it('mints single-use states that expire after their lifetime', () => {
    const pending = new PendingLogins()
    const { state, codeVerifier } = pending.begin('acme', REDIRECT, 1000)
    expect(codeVerifier).toBeTypeOf('string')
    expect(pending.consume(state, 1000)).toEqual({ providerId: 'acme', redirectUri: REDIRECT, codeVerifier, issuedAt: 1000 })
    expect(pending.consume(state, 1000)).toBeUndefined()

    const stale = pending.begin('acme', REDIRECT, 1000)
    expect(pending.consume(stale.state, 1000 + PENDING_LOGIN_LIFETIME_MILLISECONDS + 1)).toBeUndefined()
    expect(pending.consume('missing', 1000)).toBeUndefined()
  })

  it('prunes expired authorizations when it mints a new state', () => {
    const pending = new PendingLogins()
    const stale = pending.begin('acme', REDIRECT, 1000)
    const live = pending.begin('acme', REDIRECT, 1000 + PENDING_LOGIN_LIFETIME_MILLISECONDS + 1)
    expect(pending.consume(stale.state, 2000)).toBeUndefined()
    expect(pending.consume(live.state, 4000)).toBeDefined()
  })

  it('drops every in-flight authorization on clear', () => {
    const pending = new PendingLogins()
    const { state } = pending.begin('acme', REDIRECT, 1000)
    pending.clear()
    expect(pending.consume(state, 1000)).toBeUndefined()
  })
})
