/**
 * Identity-aware reverse proxy for hosted multi-user Web.
 *
 * The entry Web process owns the login routes and this plugin owns the fallback seat: after a
 * browser signs in, its unmatched requests are forwarded to the per-user backend that owns its
 * harness home. The proxy never mints an identity itself — it reads the caller through the
 * mounted Connection service — and an unresolved request is refused.
 * @module @deepseek-ai/dsh-route-users
 */

import { request as httpRequest, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ClientRequest } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { type Context, type Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { CONNECTION_TRUST_HEADER, signForwardedUser } from '@deepseek-ai/dsh-client-connection'
import type { PeerAdmission } from '@deepseek-ai/dsh-client-connection'
import { userOf, userId, type UserPrincipal } from '@deepseek-ai/dsh-user-principal'

/** Resolve the backend origin one authenticated user key routes to. */
export type BackendResolver = (userKey: string) => string | undefined

/** Admit one request to the signed-in user; the connection layer supplies this from the session cookie. */
export type UserAdmitter = (request: IncomingMessage) => UserPrincipal | undefined

/** One backend origin resolved by {@link BackendResolver}; its scheme selects http or https. */
interface BackendOrigin {
  readonly url: URL
  readonly forward: (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest
}

/**
 * Resolve one backend origin and its forwarder.
 * @param resolver - maps a user key to a backend origin.
 * @param userKey - the authenticated caller.
 * @returns the origin, or undefined when the caller has no backend.
 */
function resolveOrigin(resolver: BackendResolver, userKey: string): BackendOrigin | undefined {
  const target = resolver(userKey)
  if (target === undefined) return undefined
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return undefined
  }
  if (url.protocol === 'https:') return { url, forward: httpsRequest }
  if (url.protocol === 'http:') return { url, forward: httpRequest }
  return undefined
}

/** Headers that must not be forwarded verbatim because the proxy owns hop-by-hop framing. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

/**
 * Reverse-proxy one request to the backend its admitted user owns.
 * @param request - inbound request, admitted before this call.
 * @param response - response to stream back to the browser.
 * @param resolver - user key to backend origin mapping.
 * @param admit - resolves the request to the signed-in user, or undefined when it is not signed in.
 * @param forwardSecret - optional shared secret; when set, the forwarded caller is signed into a header.
 * @returns true when the request was proxied, false when it was refused (the response is written).
 */
export function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  resolver: BackendResolver,
  admit: UserAdmitter,
  forwardSecret?: string,
): boolean {
  const user = admit(request)
  if (user === undefined) {
    response.writeHead(401, { 'cache-control': 'no-store' })
    response.end()
    return false
  }
  const userKey = String(userId(user))
  const origin = resolveOrigin(resolver, userKey)
  if (origin === undefined) {
    response.writeHead(502, { 'cache-control': 'no-store' })
    response.end()
    return false
  }
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  headers.host = origin.url.host
  if (forwardSecret !== undefined) {
    headers[CONNECTION_TRUST_HEADER] = signForwardedUser(forwardSecret, user)
  }
  const path = (request.url ?? '/')
  const forwarded = origin.forward(
    { hostname: origin.url.hostname, port: origin.url.port || undefined, method: request.method, path, headers },
    (upstream) => {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers)
      upstream.pipe(response)
    },
  )
  forwarded.on('error', () => {
    response.writeHead(502, { 'cache-control': 'no-store' })
    response.end()
  })
  request.pipe(forwarded)
  return true
}

/**
 * Build the backend resolver from a canonical user key to loopback port mapping.
 * @param ports - one port per user key.
 * @returns a resolver returning `http://127.0.0.1:<port>` for a known key, otherwise undefined.
 */
export function portResolver(ports: Readonly<Record<string, number>>): BackendResolver {
  return (userKey: string) => {
    const port = ports[userKey]
    return port === undefined ? undefined : 'http://127.0.0.1:' + String(port)
  }
}

/** Plugin config: the canonical user key to loopback port routing table and forwarding secret. */
export interface Config {
  /** Canonical user key (`provider:tenant:subject`) to the port its backend listens on. */
  readonly ports: Readonly<Record<string, number>>
  /** Shared forwarding secret; the backend verifies the signed caller header with it. */
  readonly forwardSecret: Volatile<string | undefined>
}

export const Config = Schema.object({
  ports: Schema.dict(Schema.natural()).required(),
  forwardSecret: Schema.string().min(1).role('secret').volatile(),
})

/** Stable Cordis plugin name. */
export const name = 'route-users'

/** The entry owns login, so both services exist before the router can claim the fallback. */
export const inject = ['webServer', 'connection']

/**
 * Mount the identity-aware proxy on the webserver fallback seat.
 * @param ctx - entry Context holding the webserver and the connection layer.
 * @param config - the user key to port routing table.
 */
export function apply(ctx: Context, config: Config): void {
  const resolver = portResolver(config.ports)
  const admit = connectionAdmitter(ctx)
  const forwardSecret = config.forwardSecret.get()
  // The entry owns login, so every unmatched request is a navigation toward one
  // backend. It claims the fallback seat, so the SPA dist owner (frontend-static,
  // mounted by the shipped web-runtime row) must be disabled at the entry: the entry
  // authenticates and routes, the backends render the GUI. The backend half of this
  // seam (route-users-backend) verifies the signed caller on each backend.
  ctx.effect(() => ctx.webServer.registerFallback((request, response) => {
    proxyRequest(request, response, resolver, admit, forwardSecret)
  }), 'route-users: fallback seat')
}

type HeadersLike = Readonly<Record<string, string | readonly string[] | undefined>>

/**
 * Build the admitter that resolves one request to its canonical user key through the connection
 * layer. The entry owns login, so the signed cookie resolves against the same authority.
 * @param ctx - the entry Context holding `connection`.
 * @returns an admitter returning the canonical `userId`, or undefined when not a user.
 */
function connectionAdmitter(ctx: { connection: { admit: (request: { headers: HeadersLike }) => PeerAdmission } }): UserAdmitter {
  return (request: IncomingMessage) => {
    const headers: Record<string, string | readonly string[] | undefined> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue
      headers[name] = value
    }
    const admission = ctx.connection.admit({ headers })
    if (!('peer' in admission)) return undefined
    return userOf(admission.peer.principal)
  }
}
