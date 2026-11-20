/**
 * Hosted browser login and per-user admission (fork extension).
 *
 * A deployment that registers identity providers signs each browser in through
 * `/login`: the callback persists a durable session record and mints a signed
 * session cookie, and the credential provider installed here resolves that
 * cookie to the person's own Peer. The layer installs beside the single-user
 * token provider upstream ships; a deployment that registers no identity
 * provider never reaches it, and its launch-token flow is unchanged.
 *
 * @module @deepseek-ai/dsh-client-connection/src/hosted-login
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { IdentityProvider } from '@deepseek-ai/dsh-identity-protocol'
import type { IdentityProviderService } from '@deepseek-ai/dsh-identity-providers'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { userOf, userPrincipal, userId } from '@deepseek-ai/dsh-user-principal'
import type { UserId, UserPrincipal } from '@deepseek-ai/dsh-user-principal'
import type { BrowserAuth } from './browser-auth.ts'
import { LOGIN_CALLBACK_PATH, LOGIN_REDIRECT, MOUNT_ROOT_REDIRECT, PendingLogins } from './login.ts'
import type { BrowserSessionId, BrowserSessionRecord } from './storage.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse, ConnectionTrustRequest } from './rpc.ts'

/** Durable and credential state the hosted layer resolves requests through. */
export interface HostedLoginServices {
  /** Process credential owner; the signed session cookie carries its signature. */
  readonly browserAuth: BrowserAuth
  /** Authoritative session records; a record removal revokes the cookie. */
  readonly sessions: KvTable<BrowserSessionId, BrowserSessionRecord>
}

/**
 * Hosted login routes and the credential provider that admits their sessions.
 *
 * Every registration belongs to the installing Context, so unloading the
 * hosted layer withdraws the provider and routes with it.
 */
export class HostedLogin {
  /** One Peer per logged-in person, reused across that person's requests and sessions. */
  private readonly userPeers = new Map<UserId, PeerScope>()
  /** In-flight authorizations this process started and no provider has answered yet. */
  private readonly pendingLogins = new PendingLogins()
  private readonly owner: Context

  /**
   * @param ctx - scope owning the provider, routes, and user Peers.
   * @param services - browser credential and durable session records.
   */
  constructor(ctx: Context, private readonly services: HostedLoginServices) {
    this.owner = ctx
  }

  /**
   * Verify one request as its session cookie or forwarding proof names.
   * @param request - current request headers and cancellation facts.
   * @returns the person's Peer, or undefined so the next provider tries its own credential.
   */
  authenticate(request: ConnectionTrustRequest): PeerScope | undefined {
    if (request.signal?.aborted === true || request.socket?.destroyed === true) return undefined
    const forwarded = this.forwardedUser(request)
    if (forwarded !== undefined) return this.userPeer(forwarded)
    const sessionId = this.services.browserAuth.sessionId(request, this.secure())
    return sessionId === undefined ? undefined : this.sessionPeer(sessionId)
  }

  /**
   * Whether this hosted deployment must refuse the process owner's browser cookie.
   * The owner cookie is the single-user bootstrap; a deployment serving several
   * people admits no request through it, so an authenticated browser can never
   * become the process operator.
   * @param request - current request headers and cancellation facts.
   * @returns true when a registered identity provider serves the deployment and
   * the request carries the owner cookie.
   */
  refusesOwnerCredential(request: ConnectionTrustRequest): boolean {
    return this.providers() !== undefined && this.services.browserAuth.isAuthenticated(request, this.secure())
  }

  /**
   * Redirect one hosted index navigation that carries no live session to the
   * login route. A forwarded caller and a single-user deployment proceed.
   * @param request - index HTTP request.
   * @param response - response owned when this returns true.
   * @returns true when the login redirect was written.
   */
  hostedIndexRedirect(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    if (this.providers() === undefined) return false
    if (this.forwardedUser(request) !== undefined) return false
    const sessionId = this.services.browserAuth.sessionId(request, this.secure())
    if (sessionId !== undefined && this.sessionPeer(sessionId) !== undefined) return false
    // The launch token proves this browser may start a login, not that it is
    // the operator; a returning visitor without a session signs in again.
    this.redirect(LOGIN_REDIRECT, response)
    return true
  }

  /**
   * Start one browser login: select a registered identity provider and redirect
   * to its authorization endpoint. Without a registered provider the deployment
   * keeps single-user behavior and this route returns to the mount root.
   * @param request - GET request, optionally naming `provider`.
   * @param response - response owned to completion.
   */
  authorizeLogin(request: ConnectionIndexRequest, response: ConnectionIndexResponse): void {
    const providers = this.providers()
    if (providers === undefined) {
      this.redirect(MOUNT_ROOT_REDIRECT, response)
      return
    }
    const ids = providers.list()
    const secure = this.secure()
    const origin = this.services.browserAuth.origin(request, secure)
    /* v8 ignore next 4 -- the Host fence already refused a request without a parsable Host */
    if (origin === undefined) {
      this.services.browserAuth.writeUnauthorized(request, response)
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
    const secure = this.secure()
    const url = new URL(request.url ?? '/', 'http://dsh.invalid')
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    const pending = state === null ? undefined : this.pendingLogins.consume(state)
    const provider: IdentityProvider | undefined = pending === undefined ? undefined : this.providers()?.get(pending.providerId)
    const origin = this.services.browserAuth.origin(request, secure)
    const authority = this.services.browserAuth.audience(request, secure)
    if (state === null || code === null || pending === undefined || provider === undefined
      || origin === undefined || authority === undefined) {
      this.services.browserAuth.writeUnauthorized(request, response)
      return
    }
    let actor
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
      this.services.browserAuth.writeUnauthorized(request, response)
      return
    }
    const user = userPrincipal(actor)
    if (user === undefined) {
      this.services.browserAuth.writeUnauthorized(request, response)
      return
    }
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.services.browserAuth.sessionLifetimeMilliseconds
    const sessionId = randomUUID() as BrowserSessionId
    await this.services.sessions.put(sessionId, {
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
      'set-cookie': this.services.browserAuth.signSessionCookie(authority, sessionId, issuedAt, expiresAt, secure),
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
    const secure = this.secure()
    const sessionId = this.services.browserAuth.sessionId(request, secure)
    if (sessionId !== undefined) await this.services.sessions.delete(sessionId)
    const authority = this.services.browserAuth.audience(request, secure)
    const headers: Record<string, string> = {
      'cache-control': 'no-store',
      'location': MOUNT_ROOT_REDIRECT,
      'referrer-policy': 'no-referrer',
    }
    /* v8 ignore else -- the Host fence already refused a request without a parsable Host */
    if (authority !== undefined) headers['set-cookie'] = this.services.browserAuth.clearSessionCookie(authority, secure)
    response.writeHead(303, headers)
    response.end()
  }

  /**
   * The registered identity-adapter registry, or undefined for a single-user
   * deployment. An empty registry (the seam mounted with no adapter) is
   * single-user: the hosted routes gate on a registered provider, not on the
   * seam's presence, so a deployment that enables no provider keeps the
   * launch-token-to-owner-cookie loopback.
   * @returns the registry with at least one adapter, or undefined.
   */
  private providers(): IdentityProviderService | undefined {
    const providers = this.owner.get('identityProviders')
    return providers !== undefined && providers.list().length > 0 ? providers : undefined
  }

  /** The forwarding proof's caller, when a hosted entry authenticated the request. */
  private forwardedUser(request: ConnectionTrustRequest): UserPrincipal | undefined {
    const forwarded = this.owner.get('connectionTrust')?.principalOf(request)
    return forwarded === undefined ? undefined : userOf(forwarded)
  }

  /** Resolve one durable session id to that person's Peer, refusing revoked or expired records. */
  private sessionPeer(sessionId: BrowserSessionId): PeerScope | undefined {
    const record = this.services.sessions.get(sessionId)
    if (record === undefined) return undefined
    const now = Date.now()
    // Expiry refuses admission; the record itself is removed by logout.
    if (record.issuedAt > now || record.expiresAt <= now) return undefined
    return this.userPeer(record.user)
  }

  /** The one Peer a logged-in person's requests share, keyed by their canonical user id. */
  private userPeer(user: UserPrincipal): PeerScope {
    const key = userId(user)
    const existing = this.userPeers.get(key)
    if (existing !== undefined && !existing.signal.aborted) return existing
    const peer = this.owner.connection.createPeer({ principal: user })
    this.userPeers.set(key, peer)
    peer.ctx.effect(() => () => {
      if (this.userPeers.get(key) === peer) this.userPeers.delete(key)
    }, 'client-connection: hosted user Peer')
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

  /** The mounted carrier's TLS protocol; only that listener decides `Secure`. */
  private secure(): boolean {
    return this.owner.get('webServer')?.protocol === 'https:'
  }
}
