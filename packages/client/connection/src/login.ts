/**
 * Browser login routes and the in-flight authorizations they start.
 *
 * A login is two requests: `/login` selects one registered identity provider and
 * redirects to its authorization endpoint with a single-use `state` value, and
 * `/login/callback` exchanges the returned code for an identity that
 * `HostConnectionService` turns into a durable browser session. The in-flight
 * `state` table is process-local by design: a restart abandons half-finished
 * logins (the user starts again) instead of persisting partial credentials.
 *
 * @module @deepseek-ai/dsh-client-connection/src/login
 */

import { randomBytes } from 'node:crypto'

/** Route starting one browser login. */
export const LOGIN_PATH = '/login'

/** Route an identity provider redirects back to. */
export const LOGIN_CALLBACK_PATH = '/login/callback'

/** Route revoking the current browser session. */
export const LOGOUT_PATH = '/logout'

/** Mount-relative redirect to the login route, safe behind a mount prefix. */
export const LOGIN_REDIRECT = `./${LOGIN_PATH.slice(1)}`

/** Mount-relative redirect to the mount root, from a route one segment deep. */
export const MOUNT_ROOT_REDIRECT = '../'

/** How long one in-flight authorization may wait for its provider callback. */
export const PENDING_LOGIN_LIFETIME_MILLISECONDS = 10 * 60 * 1000

/** One authorization this process started and its provider has not answered yet. */
export interface PendingLogin {
  /** Registered provider the authorization was started with. */
  readonly providerId: string
  /** Callback URL the provider must redirect to; the exchange repeats it. */
  readonly redirectUri: string
  /** PKCE S256 code verifier the exchange proves; absent for a provider that uses no PKCE. */
  readonly codeVerifier?: string
  /** Millisecond instant the authorization was issued. */
  readonly issuedAt: number
}

/**
 * Single-use in-flight authorizations keyed by their OAuth `state` value.
 *
 * `begin` mints the state and records the authorization; `consume` removes the
 * entry whatever the outcome, so a replayed callback never exchanges twice.
 */
export class PendingLogins {
  private readonly entries = new Map<string, PendingLogin>()

  /**
   * @param lifetimeMilliseconds - how long one authorization may stay unanswered.
   */
  constructor(
    private readonly lifetimeMilliseconds = PENDING_LOGIN_LIFETIME_MILLISECONDS,
  ) {}

  /**
   * Mint one state value and its PKCE code verifier, and record the authorization they belong to.
   * @param providerId - registered provider the authorization targets.
   * @param redirectUri - callback URL the provider must redirect to.
   * @param now - current millisecond instant; the entry expires relative to it.
   * @returns the single-use state value to send to the provider and the code verifier its callback repeats.
   */
  begin(providerId: string, redirectUri: string, now = Date.now()): { state: string; codeVerifier: string } {
    this.prune(now)
    const state = randomBytes(32).toString('base64url')
    const codeVerifier = randomBytes(32).toString('base64url')
    this.entries.set(state, { providerId, redirectUri, codeVerifier, issuedAt: now })
    return { state, codeVerifier }
  }

  /**
   * Consume one state value; a state is single-use whether or not it was still live.
   * @param state - the state value a provider callback returned.
   * @param now - current millisecond instant; an entry older than the lifetime is dropped.
   * @returns the pending authorization, or undefined when unknown or expired.
   */
  consume(state: string, now = Date.now()): PendingLogin | undefined {
    const entry = this.entries.get(state)
    this.entries.delete(state)
    if (entry === undefined) return undefined
    return now - entry.issuedAt <= this.lifetimeMilliseconds ? entry : undefined
  }

  /** Drop every in-flight authorization; the unmount path for the owning service. */
  clear(): void {
    this.entries.clear()
  }

  private prune(now: number): void {
    for (const [state, entry] of this.entries) {
      if (now - entry.issuedAt > this.lifetimeMilliseconds) this.entries.delete(state)
    }
  }
}
