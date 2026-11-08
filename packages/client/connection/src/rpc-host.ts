/** Host registry and HTTP adapter for generic Connection RPC channels. */

import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IdentityActor } from '@deepseek-ai/dsh-identity-protocol'
import type { IdentityProviderService } from '@deepseek-ai/dsh-identity-providers'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { PeerId, PeerScope, Principal } from '@deepseek-ai/dsh-typert-protocol'
import { userOf, userPrincipal, userId } from '@deepseek-ai/dsh-user-principal'
import type { UserId, UserPrincipal } from '@deepseek-ai/dsh-user-principal'
import type { ConnectionInteractions } from './connect-protocol.ts'
import { LOGIN_CALLBACK_PATH, LOGIN_REDIRECT, MOUNT_ROOT_REDIRECT, PendingLogins } from './login.ts'
import type { BrowserSessionId, BrowserSessionRecord } from './storage.ts'
import {
  RpcId,
  type ClientRequest,
  type RpcId as RpcIdType,
} from './rpc.ts'
import { clientRequestSchema } from './rpc-schema.ts'
import { bridge } from './http-bridge.ts'
import { isRemoteAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { API_PATH } from './api-path.ts'
import type { BrowserAuth } from './browser-auth.ts'
import { Peer } from './peer.ts'
import type {
  PeerAdmission,
  ConnectionAdmission,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionFetchRoute,
  ConnectionFetchHandler,
  HostConnectionFetch,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcResult,
  ConnectionRequestRejection,
  ConnectionTrustRequest,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface PeerRecord {
  readonly peer: Peer
  ownsSocket: boolean
}

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly fetchHandler: ConnectionFetchHandler
}

interface RegisteredFetchRoute {
  readonly methods: ReadonlySet<string>
  readonly requestBody: ConnectionFetchRoute['requestBody']
  readonly fetch: ConnectionFetchRoute['fetch']
}

interface ConnectionServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcIdType
  readonly result: ConnectionRpcResult<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle
  }
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle {
  /** The Peer a local or loopback browser connection shares; a hosted login mints a user Peer instead. */
  readonly browserPeer: PeerScope
  private readonly peers = new Map<PeerId, PeerRecord>()
  /** One Peer per logged-in person, reused across that person's requests and sessions. */
  private readonly userPeers = new Map<UserId, Peer>()
  /** In-flight authorizations this process started and no provider has answered yet. */
  private readonly pendingLogins = new PendingLogins()
  private readonly owner: Context
  private disposed = false
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly fetchRoutes = new Map<string, RegisteredFetchRoute>()

  readonly allowsRemoteAuthorities: boolean

  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by the Host/Origin fence.
   * @param browserAuth - process token and persistent browser-session owner.
   * @param sessions - durable browser-session records a signed cookie resolves to.
   */
  constructor(
    ctx: Context,
    private readonly trustedHosts: readonly string[],
    private readonly browserAuth: BrowserAuth,
    private readonly sessions: KvTable<BrowserSessionId, BrowserSessionRecord>,
  ) {
    super(ctx, 'connection')
    this.owner = ctx
    this.browserPeer = new Peer(ctx, { principal: { kind: 'owner' } })
    ctx.effect(() => async () => {
      this.disposed = true
      const peers = [
        this.browserPeer,
        ...Array.from(this.peers.values(), record => record.peer),
        ...this.userPeers.values(),
      ]
      this.peers.clear()
      this.userPeers.clear()
      this.pendingLogins.clear()
      await Promise.all(peers.map(peer => peer.dispose()))
    }, 'client-connection: Peer scopes')
    this.allowsRemoteAuthorities = trustedHosts.some(isRemoteAuthority)
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler) => this.register(owner, channel, handler),
      intercept: (channel, matches, handler) =>
        this.registerInterceptor(owner, channel, matches, handler),
    }
  }

  /** Exact Fetch-route registry scoped to the Context reading this service. */
  get fetch(): HostConnectionFetch {
    const owner = this.ctx
    return {
      register: route => this.registerFetchRoute(owner, route),
    }
  }

  /** Apply the Host/Origin fence and require an authenticated live Peer. */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    const admission = this.admit(request)
    return 'rejection' in admission ? admission.rejection : undefined
  }

  /**
   * Admit one request as its signed credential names: a logged-in user's Peer, the
   * bootstrap owner Peer of a single-user deployment, or an independent API Peer.
   * @param request - request headers from the HTTP or upgrade request.
   * @returns the Peer the request speaks for, or the status refusing it.
   */
  admit(request: ConnectionTrustRequest): PeerAdmission {
    if (!this.isTrusted(request)) return { rejection: 403 }
    if (this.disposed) return { rejection: 401 }
    // A mounted trusted forwarder lets the entry authenticate a request this backend
    // cannot: the caller is recovered from the forwarding proof, never minted here.
    const trusted = this.owner.get('connectionTrust')
    const forwarded = trusted === undefined ? undefined : trusted.principalOf(request)
    if (forwarded !== undefined) {
      const user = userOf(forwarded)
      if (user !== undefined) return { peer: this.userPeer(user) }
    }
    const secure = this.owner.get('webServer')?.protocol === 'https:'
    // A browser session always speaks as its logged-in user, never as the owner.
    const sessionId = this.browserAuth.sessionId(request, secure)
    if (sessionId !== undefined) {
      const peer = this.resolveUserPeer(sessionId)
      return peer === undefined ? { rejection: 401 } : { peer }
    }
    // The owner cookie is the single-user bootstrap; a hosted deployment refuses
    // it so an authenticated browser can never be the process operator.
    if (this.browserAuth.isAuthenticated(request, secure)) {
      return this.identityProviders() === undefined ? { peer: this.browserPeer } : { rejection: 401 }
    }
    const id = this.browserAuth.authenticateApi(request, secure)
    const record = id === undefined ? undefined : this.peers.get(id)
    return record === undefined ? { rejection: 401 } : { peer: record.peer }
  }

  /** Create one in-process Peer owned by the Context that read this service. */
  createPeer(options: { readonly principal: Principal; readonly interactions?: ConnectionInteractions }): PeerScope {
    return new Peer(this.ctx, options)
  }

  /** Claim API socket ownership synchronously; callers release on termination or failed upgrade. */
  admitConnection(request: ConnectionTrustRequest): ConnectionAdmission {
    const admission = this.admit(request)
    if ('rejection' in admission) return admission
    const record = this.peers.get(admission.peer.id)
    if (record === undefined) return { ...admission, release: () => Promise.resolve() }
    if (record.ownsSocket) return { rejection: 409 }
    record.ownsSocket = true
    let released: Promise<void> | undefined
    return {
      peer: record.peer,
      release: () => {
        if (released !== undefined) return released
        this.peers.delete(record.peer.id)
        released = record.peer.dispose()
        return released
      },
    }
  }

  /**
   * The registered identity-adapter registry, or undefined for a single-user deployment.
   * An empty registry (the seam mounted with no adapter) is single-user: the hosted login
   * paths gate on a registered provider, not on the seam's presence, so a deployment that
   * enables no provider keeps the launch-token-to-owner-cookie loopback.
   */
  private identityProviders(): IdentityProviderService | undefined {
    const providers = this.owner.get('identityProviders')
    return providers !== undefined && providers.list().length > 0 ? providers : undefined
  }

  /** Resolve one durable session id to that person's Peer, refusing revoked or expired records. */
  private resolveUserPeer(sessionId: BrowserSessionId): PeerScope | undefined {
    const record = this.sessions.get(sessionId)
    if (record === undefined) return undefined
    const now = Date.now()
    // Expiry refuses admission; the record itself is removed by logout.
    if (record.issuedAt > now || record.expiresAt <= now) return undefined
    return this.userPeer(record.user)
  }

  /** The one Peer a logged-in person's requests share, keyed by their canonical user id. */
  private userPeer(user: UserPrincipal): PeerScope {
    const key = userId(user)
    let peer = this.userPeers.get(key)
    if (peer === undefined) {
      peer = new Peer(this.owner, { principal: user })
      this.userPeers.set(key, peer)
    }
    return peer
  }

  /** Write one mount-relative 303 redirect with no stored response. */
  private redirect(location: string, response: ConnectionIndexResponse): void {
    response.writeHead(303, {
      'cache-control': 'no-store',
      'location': location,
      'referrer-policy': 'no-referrer',
    })
    response.end()
  }

  private isTrusted(request: ConnectionTrustRequest): boolean {
    const carrier = this.owner.get('webServer')
    return isTrustedApiRequest(request, this.trustedHosts, carrier?.host, carrier?.protocol ?? 'http:')
  }

  private publishPeer(interactions: ConnectionInteractions): PeerId {
    const peer = new Peer(this.owner, { principal: { kind: 'owner' }, interactions })
    this.peers.set(peer.id, { peer, ownsSocket: false })
    return peer.id
  }

  /**
   * Authenticate and publish a credential before sending the connect redirect.
   * @param request - launch-token request on /connect.
   * @param response - response owned to completion.
   */
  authorizeConnect(request: ConnectionIndexRequest, response: ConnectionIndexResponse): void {
    if (!this.isTrusted(request) || this.disposed) {
      response.writeHead(this.disposed ? 401 : 403)
      response.end(this.disposed ? 'unauthorized' : 'forbidden')
      return
    }
    this.browserAuth.authorizeConnect(request, response,
      this.owner.get('webServer')?.protocol === 'https:', interactions => this.publishPeer(interactions))
  }

  /**
   * Authenticate one frontend index request. A logged-in session renders for its
   * user Peer, a single-user deployment renders for the bootstrap owner Peer, and a
   * hosted deployment sends every browser without a session to the login route: a
   * launch token starts the flow and a returning visitor signs in again, so neither
   * ever receives an owner cookie.
   * @param request - root or configured-index HTTP request.
   * @param response - response owned when no Peer is returned.
   * @returns the Peer the index renders for, or undefined after writing the response.
   */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): PeerScope | undefined {
    // A trusted forwarder authenticates the index request before any cookie path, so a
    // backend serving one person still renders the entry-admitted index for that person.
    const trusted = this.owner.get('connectionTrust')
    const forwarded = trusted === undefined ? undefined : trusted.principalOf(request)
    if (forwarded !== undefined) {
      const user = userOf(forwarded)
      if (user !== undefined) return this.userPeer(user)
    }
    const secure = this.owner.get('webServer')?.protocol === 'https:'
    const sessionId = this.browserAuth.sessionId(request, secure)
    if (sessionId !== undefined) {
      const peer = this.resolveUserPeer(sessionId)
      if (peer === undefined) this.browserAuth.writeUnauthorized(request, response)
      return peer
    }
    if (this.identityProviders() !== undefined) {
      // A hosted deployment never hands the owner to a browser: the launch token
      // proves this browser may start a login, not that it is the operator.
      if (this.browserAuth.isLaunchRequest(request, secure)) {
        this.redirect(LOGIN_REDIRECT, response)
        return undefined
      }
      // A returning visitor without a session signs in again instead of meeting a
      // bare refusal: the index is a navigation, and the login route is the only
      // hosted way to obtain a session.
      this.redirect(LOGIN_REDIRECT, response)
      return undefined
    }
    return this.browserAuth.authorizeIndex(request, response, secure) ? this.browserPeer : undefined
  }

  /**
   * Start one browser login: select the configured identity provider and redirect
   * to its authorization endpoint. Without a registered provider the deployment
   * keeps single-user behavior and this route returns to the mount root.
   * @param request - GET request, optionally naming `provider`.
   * @param response - response owned to completion.
   */
  authorizeLogin(request: ConnectionIndexRequest, response: ConnectionIndexResponse): void {
    if (!this.isTrusted(request) || this.disposed) {
      response.writeHead(this.disposed ? 401 : 403)
      response.end(this.disposed ? 'unauthorized' : 'forbidden')
      return
    }
    const providers = this.identityProviders()
    if (providers === undefined) {
      this.redirect(MOUNT_ROOT_REDIRECT, response)
      return
    }
    const ids = providers.list()
    const secure = this.owner.get('webServer')?.protocol === 'https:'
    const origin = this.browserAuth.origin(request, secure)
    /* v8 ignore next 4 -- the Host fence above already refused a request without a parsable Host */
    if (origin === undefined) {
      this.browserAuth.writeUnauthorized(request, response)
      return
    }
    const url = new URL(request.url ?? '/', 'http://dsh.invalid')
    const selected = url.searchParams.get('provider')
    const id = selected ?? (ids.length === 1 ? ids[0] : undefined)
    const provider = id === undefined ? undefined : providers.get(id)
    if (provider === undefined) {
      response.writeHead(400, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
      response.end(selected === null
        ? `identity provider must be selected with ?provider= (${ids.join(', ')})\n`
        : `unknown identity provider ${JSON.stringify(selected)}\n`)
      return
    }
    const redirectUri = `${origin}${LOGIN_CALLBACK_PATH}`
    const { state, codeVerifier } = this.pendingLogins.begin(provider.id, redirectUri)
    const challenge = createHash('sha256').update(codeVerifier).digest('base64url')
    let location: string
    try {
      location = provider.authorizationUrl({
        state, redirectUri, scopes: provider.scopes, codeChallenge: challenge, codeChallengeMethod: 'S256',
      }).href
    } catch (error) {
      // A provider that cannot build its own endpoint is a deployment fault; the
      // browser gets no redirect and the failure is reported once here.
      this.owner.logger.warn(`client-connection: identity provider '${provider.id}' produced no authorization URL: ${String(error)}`)
      response.writeHead(502, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    this.redirect(location, response)
  }

  /**
   * Complete one browser login: exchange the provider code, persist the session
   * record, and mint the signed session cookie.
   * @param request - provider callback carrying `code` and `state`.
   * @param response - response owned to completion.
   * @returns resolution after the redirect is written.
   */
  async authorizeLoginCallback(
    request: ConnectionIndexRequest,
    response: ConnectionIndexResponse,
  ): Promise<void> {
    if (!this.isTrusted(request) || this.disposed) {
      response.writeHead(this.disposed ? 401 : 403)
      response.end(this.disposed ? 'unauthorized' : 'forbidden')
      return
    }
    const secure = this.owner.get('webServer')?.protocol === 'https:'
    const url = new URL(request.url ?? '/', 'http://dsh.invalid')
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    const pending = state === null ? undefined : this.pendingLogins.consume(state)
    const provider = pending === undefined ? undefined : this.identityProviders()?.get(pending.providerId)
    const origin = this.browserAuth.origin(request, secure)
    const authority = this.browserAuth.audience(request, secure)
    if (state === null || code === null || pending === undefined || provider === undefined
      || origin === undefined || authority === undefined) {
      this.browserAuth.writeUnauthorized(request, response)
      return
    }
    let actor: IdentityActor
    try {
      actor = await provider.exchange({
        code,
        state,
        redirectUri: pending.redirectUri,
        ...(pending.codeVerifier === undefined ? {} : { codeVerifier: pending.codeVerifier }),
      })
    } catch (error) {
      // The provider refused the code (expired, replayed, or mismatched); the
      // browser is not signed in and starts again from /login.
      this.owner.logger.warn(`client-connection: identity provider '${provider.id}' rejected the callback: ${String(error)}`)
      this.browserAuth.writeUnauthorized(request, response)
      return
    }
    const user = userPrincipal(actor)
    if (user === undefined) {
      this.browserAuth.writeUnauthorized(request, response)
      return
    }
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.browserAuth.sessionLifetimeMilliseconds
    const sessionId = randomUUID() as BrowserSessionId
    await this.sessions.put(sessionId, {
      sessionId,
      user,
      userKey: userId(user),
      providerId: user.providerId,
      issuedAt,
      expiresAt,
      csrf: state,
    })
    response.writeHead(303, {
      'cache-control': 'no-store',
      'location': MOUNT_ROOT_REDIRECT,
      'referrer-policy': 'no-referrer',
      'set-cookie': this.browserAuth.signSessionCookie(authority, sessionId, issuedAt, expiresAt, secure),
    })
    response.end()
  }

  /**
   * End one browser session: delete its durable record and expire the cookie. The
   * next request carrying that cookie resolves to no Peer and is refused.
   * @param request - logout request carrying the session cookie.
   * @param response - response owned to completion.
   * @returns resolution after the record is deleted and the redirect is written.
   */
  async authorizeLogout(
    request: ConnectionIndexRequest,
    response: ConnectionIndexResponse,
  ): Promise<void> {
    if (!this.isTrusted(request) || this.disposed) {
      response.writeHead(this.disposed ? 401 : 403)
      response.end(this.disposed ? 'unauthorized' : 'forbidden')
      return
    }
    const secure = this.owner.get('webServer')?.protocol === 'https:'
    const sessionId = this.browserAuth.sessionId(request, secure)
    if (sessionId !== undefined) await this.sessions.delete(sessionId)
    const authority = this.browserAuth.audience(request, secure)
    const headers: Record<string, string> = {
      'cache-control': 'no-store',
      'location': MOUNT_ROOT_REDIRECT,
      'referrer-policy': 'no-referrer',
    }
    /* v8 ignore else -- the Host fence above already refused a request without a parsable Host */
    if (authority !== undefined) headers['set-cookie'] = this.browserAuth.clearSessionCookie(authority, secure)
    response.writeHead(303, headers)
    response.end()
  }

  /** Add this process's launch token to the clean application URL. */
  authenticatedUrl(baseUrl: string): string {
    return this.browserAuth.authenticatedUrl(baseUrl)
  }

  /**
   * Compose one shared-channel Fetch handler from exact routes and its interceptor.
   * @param channel - shared channel mounted by Connection.
   * @returns Fetch handler that selects one owner or returns 404.
   */
  createSharedFetchHandler(
    channel: '/api',
  ): ConnectionFetchHandler {
    return {
      requestBodyMode: ({ method, url }) => {
        const route = this.fetchRoutes.get(url.pathname)
        return route?.methods.has(method) === true ? route.requestBody : 'buffered'
      },
      fetch: (request, peer) => {
        const pathname = new URL(request.url).pathname
        const route = this.fetchRoutes.get(pathname)
        if (route?.methods.has(request.method) === true) {
          // Exact routes bypass Gateway access checks, so only the owner reaches them.
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
          if (peer.principal.kind !== 'owner') return Promise.resolve(new Response('forbidden', { status: 403 }))
          return route.fetch(request)
        }
        const endpoint = endpointFromPath(channel, pathname)
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return Promise.resolve(new Response('not found', { status: 404 }))
        }
        return interceptor.fetchHandler.fetch(request, peer)
      },
    }
  }

  private registerFetchRoute(
    owner: Context,
    route: ConnectionFetchRoute,
  ): () => Promise<void> {
    assertFetchRoute(route)
    const registered: RegisteredFetchRoute = {
      methods: new Set(route.methods),
      requestBody: route.requestBody,
      fetch: route.fetch,
    }
    return owner.effect(() => {
      if (this.fetchRoutes.has(route.path)) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
      }
      this.fetchRoutes.set(route.path, registered)
      return () => { this.fetchRoutes.delete(route.path) }
    }, `client-connection: ${route.path} Fetch route`)
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    assertChannel(channel)
    const fetchHandler = rpcFetchHandler(channel, handler)
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        const admission = this.admit(req)
        if ('rejection' in admission) {
          res.writeHead(admission.rejection)
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await bridge(req, res, fetchHandler, admission.peer)
      },
    }
    return owner.effect(
      () => owner.webServer.register(route),
      `client-connection: ${channel} rpc channel`,
    )
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, handler),
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request: Request, peer: PeerScope): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'gateway/bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }

      try {
        const result = await handler(endpoint, message.payload, request.signal, peer)
        return fullResponse(message.rpcId, result)
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(body: unknown, issues: readonly object[]): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'gateway/bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(rpcId: RpcIdType, error: ConnectionRpcFailure): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: RpcIdType, result: Awaited<ReturnType<ConnectionRpcHandler>>): Response {
  if (!result.ok) {
    const body: ConnectionServerResponse = { type: 'server-response', rpcId, result }
    return Response.json(body)
  }
  const { attachments, ...success } = result
  const body: ConnectionServerResponse = { type: 'server-response', rpcId, result: success }
  if (attachments === undefined || attachments.length === 0) return Response.json(body)
  const parts = new FormData()
  const attachmentMetadata = attachments.map((attachment, index) => {
    const part = `bytes-${index}`
    // FileSystem bytes may have SharedArrayBuffer backing, which BlobPart excludes.
    parts.set(part, new Blob([new Uint8Array(attachment.bytes)]))
    return { path: [...attachment.path], codec: 'bytes' as const, part }
  })
  parts.set('metadata', JSON.stringify({ ...body, attachments: attachmentMetadata }))
  return new Response(parts)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}

function assertFetchRoute(route: ConnectionFetchRoute): void {
  if (endpointFromPath(API_PATH, route.path) === undefined) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  const methods = new Set(route.methods)
  if (methods.size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
}
