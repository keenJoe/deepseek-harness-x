/** Host HTTP bridge for browser-client RPC. */
import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-storage-domain'
// Activates the webServer Context merge used below.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority } from './api-request-trust.ts'
import { BrowserAuth } from './browser-auth.ts'
import type { ConnectionTrust } from './rpc.ts'
export { createConnectionTrustContext, signForwardedUser, verifyForwardedUser, CONNECTION_TRUST_HEADER, CONNECTION_TRUST_TTL_MS } from './connection-trust.ts'
import { HostedLogin } from './hosted-login.ts'
import { LOGIN_CALLBACK_PATH, LOGIN_PATH, LOGOUT_PATH } from './login.ts'
import { HostConnectionService } from './rpc-host.ts'
import { browserSessionsDomainSpec } from './storage.ts'
import { ConnectionAuthentication } from './authentication.ts'
import { ConnectionRecoveryConfigSchema, resolveConnectionConfig, type ConnectionRecoveryConfig } from './recovery-config.ts'
import type { ConnectionConfig } from './types.ts'

export type {
  AuthenticationProvider,
  ConnectionTrust,
  PeerAdmission,
  ConnectionFetchMethod,
  ConnectionFetchHandler,
  ConnectionFetchRoute,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcAttachment,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcHandlerResult,
  ConnectionRpcResult,
  ConnectionRequestBodyMode,
  ConnectionTrustRequest,
  ClientRequest,
  HostConnectionHandle,
  HostConnectionFetch,
  HostConnectionRpc,
  RpcMessage,
  ServerResponse,
} from './rpc.ts'
export type { PeerId, PeerScope, Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
export { RpcId, transportError } from './rpc.ts'
export { Peer } from './peer.ts'
export type { PeerOptions } from './peer.ts'
export { CONNECT_PATH, type ConnectionInteractions } from './connect-protocol.ts'
export {
  clientRequestSchema,
  rpcErrorSchema,
  rpcIdSchema,
  rpcMessageSchema,
  rpcResultSchema,
  serverResponseSchema,
} from './rpc-schema.ts'
export { HostConnectionService } from './rpc-host.ts'
export { ConnectionAuthentication } from './authentication.ts'

export { API_PATH } from './api-path.ts'

export { LOGIN_CALLBACK_PATH, LOGIN_PATH, LOGOUT_PATH, PENDING_LOGIN_LIFETIME_MILLISECONDS, PendingLogins } from './login.ts'
export { browserSessionRecordSchema, browserSessionsDomainSpec } from './storage.ts'
export type { BrowserSessionId, BrowserSessionRecord } from './storage.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional trusted-forwarder admission (fork extension); a backend mounts it to accept entry-authenticated requests. */
    connectionTrust?: ConnectionTrust
  }

  interface Events {
    /**
     * Admit or wrap an authenticated shared API request, including body transfer.
     * Existing requests continue when a listener refuses subsequent requests.
     * @param request - Authenticated incoming HTTP request.
     * @param response - Response owned until the delegated bridge settles.
     * @param next - Delegate to the next listener or the shared API bridge.
     * @mode waterfall
     */
    'connection/request'(request: IncomingMessage, response: ServerResponse, next: () => Promise<void>): Promise<void>
  }
}

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection. */
export const inject: string[] = []

export type { ConnectionConfig } from './types.ts'

/** Host request limits and trusted authorities; `recovery` is synced to the browser. */
export const Config: z<Omit<ConnectionConfig, 'recovery'> & { recovery?: ConnectionRecoveryConfig }, ConnectionConfig> = z.object({
  recovery: ConnectionRecoveryConfigSchema.default({}).volatile(),
  trustedHosts: z.array(String).default([]),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
  cookieMaxAgeDays: z.natural().min(1).default(30),
})

/**
 * Provides carrier-neutral RPC and Fetch registries. When `webServer` is
 * present, the plugin applies Host/Origin checks and registered authentication
 * to WebServer routes and mounts the `/api` browser transport. When a
 * deployment registers identity providers, the hosted login layer signs each
 * browser in and admits that person's own Peer.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config?: ConnectionConfig): Promise<void> {
  // Config boundary: the schema admits a NaN backoff factor, which the synced Config projection cannot carry as lossless
  // JSON; rejecting it at load keeps a row with an unprojectable recovery value off the graph.
  resolveConnectionConfig(config?.recovery?.get())
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  const cookieMaxAgeDays = config?.cookieMaxAgeDays ?? 30
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  new ConnectionAuthentication(ctx)
  // Built directly on this scope so the service exists as soon as the plugin
  // loads, before any injected route or the web server starts serving.
  const connection = new HostConnectionService(ctx, trustedHosts)
  ctx.inject(['webServer'], (webCtx) => {
    assertImageBodyCapacity(webCtx, maxRequestBodyBytes)
    const fetchHandler = connection.createSharedFetchHandler(API_PATH)
    const route: WebRoute = {
      kind: 'prefix',
      path: API_PATH,
      auth: 'required',
      handler: async (req, res, peer) => {
        if (peer === undefined || res.destroyed) return
        await webCtx.waterfall('connection/request', req, res, () => bridge(req, res, fetchHandler, peer, maxRequestBodyBytes))
      },
    }
    webCtx.effect(() => webCtx.webServer.register(route), 'client-connection: /api route')
  })
  // The hosted login layer needs a credential store for its signing key and a
  // durable domain for session records; a composition without them keeps the
  // single-user launch-token flow. Awaited so a deployment that mounts both in
  // the same composition never serves a request before the layer exists.
  if (ctx.get('credentials') !== undefined && ctx.get('storageDomain') !== undefined) {
    await installHostedLogin(ctx, connection, cookieMaxAgeDays)
  } else {
    // Install on this plugin's own scope, not on the injected child: the child is
    // unloaded whenever a dependency changes, and it can unload while the domain
    // is still opening. The injection only reports readiness; the install must
    // outlive it, so its registrations belong to the scope that owns the service.
    let installing = false
    let installed = false
    ctx.inject(['credentials', 'storageDomain'], () => {
      if (installing || installed) return
      installing = true
      void installHostedLogin(ctx, connection, cookieMaxAgeDays).then(() => {
        installed = true
      }, (error: unknown) => {
        ctx.logger.error('client-connection: hosted login install failed', error)
      }).finally(() => {
        installing = false
      })
    })
  }
  ctx.inject(['attachments'], (attachmentCtx) => {
    assertImageBodyCapacity(attachmentCtx, maxRequestBodyBytes)
  })
}

/**
 * Install the hosted browser-login layer once its services resolve.
 * @param ctx - scope owning the layer's credential, domain, provider, and routes.
 * @param connection - service the layer admits sessions through.
 * @param cookieMaxAgeDays - absolute browser-session cookie lifetime.
 * @returns resolution after the layer has registered; a failure rejects so the scope reports it.
 */
async function installHostedLogin(ctx: Context, connection: HostConnectionService, cookieMaxAgeDays: number): Promise<void> {
  // Optional services: read through `ctx.get`, never the undeclared property proxy.
  const credentials = ctx.get('credentials')
  const storageDomain = ctx.get('storageDomain')
  if (credentials === undefined || storageDomain === undefined) {
    throw new Error('client-connection hosted login requires credentials and storageDomain')
  }
  const browserAuth = await BrowserAuth.create(ctx[Context.root], credentials, cookieMaxAgeDays)
  // The durable session store is authoritative account state: an unreadable record
  // fails the load rather than being skipped.
  const sessionsDomain = await storageDomain.open(browserSessionsDomainSpec)
  ctx.effect(() => async () => { await sessionsDomain.close() }, 'client-connection: browser-sessions domain')
  const hosted = new HostedLogin(ctx, { browserAuth, sessions: sessionsDomain.table('sessions') })
  ctx.effect(() => {
    connection.installHostedLogin(hosted)
    return () => { connection.installHostedLogin(undefined) }
  }, 'client-connection: hosted login')
  ctx.effect(
    () => connection.authentication.register({ authenticate: request => hosted.authenticate(request) }),
    'client-connection: hosted sessions provider',
  )
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: LOGIN_PATH, auth: 'anonymous',
      handler: (req, res) => { hosted.authorizeLogin(req, res) },
    }), 'client-connection: /login route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: LOGIN_CALLBACK_PATH, auth: 'anonymous',
      handler: (req, res) => hosted.authorizeLoginCallback(req, res),
    }), 'client-connection: /login/callback route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: LOGOUT_PATH, auth: 'anonymous',
      handler: (req, res) => hosted.authorizeLogout(req, res),
    }), 'client-connection: /logout route')
  })
}
