/**
 * Backend half of the trusted-forwarder seam: verifies the entry-signed caller header.
 *
 * Mount this on each per-user backend so its Connection service admits requests an entry process
 * already authenticated. The forwarding secret is separate from the login cookie key, so a backend
 * that verifies forwarded callers still cannot mint login sessions.
 * @module @deepseek-ai/dsh-route-users-backend
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createConnectionTrustContext } from '@deepseek-ai/dsh-client-connection'

/** Deployment choices for the backend trust half. */
export interface Config {
  /** Shared forwarding secret; must equal the entry router’s `forwardSecret`. */
  readonly forwardSecret: Volatile<string | undefined>
}

export const Config = Schema.object({
  forwardSecret: Schema.string().min(1).role('secret').volatile(),
})

/** Stable Cordis plugin name. */
export const name = 'route-users-backend'

/**
 * Provide the ConnectionTrust context so the mounted Connection admits entry-authenticated requests.
 * @param ctx - the backend Context holding `connection`.
 * @param config - the shared forwarding secret.
 */
export function apply(ctx: Context, config: Config): void {
  const secret = config.forwardSecret.get()
  if (secret === undefined) {
    throw new Error('route-users-backend: forwardSecret is required')
  }
  ctx.provide('connectionTrust', createConnectionTrustContext(secret))
}
