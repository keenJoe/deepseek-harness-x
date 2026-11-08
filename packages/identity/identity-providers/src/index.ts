/**
 * Service Definition for the identity-provider capability seam (`ctx.identityProviders`): a
 * registry of deployment-selected identity adapters that a hosted Web login resolves to one
 * logged-in person.
 *
 * A provider plugin registers one adapter under a stable id that is also the `providerId`
 * recorded on every resolved identity. {@link IdentityProviderService.register} validates the
 * id, its match with the adapter's own id, and the declared scopes before mutating, so an
 * invalid or conflicting registration publishes nothing, and its disposer releases the id
 * together with the registering fiber. The seam owns the registry, never the protocol: a second
 * identity source arrives as another adapter rather than another seam, and a deployment that
 * registers no provider keeps the single-user loopback behavior.
 *
 * ```ts
 * const dispose = ctx.identityProviders.register('example-oidc', adapter)
 * ctx.identityProviders.list()            // ['example-oidc', ...]
 * ctx.identityProviders.get('example-oidc')   // adapter, or undefined
 * ```
 *
 * @module @deepseek-ai/dsh-identity-providers
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { IdentityProvider } from './types.ts'

export type {
  IdentityActor,
  IdentityAuthorizationRequest,
  IdentityExchangeRequest,
  IdentityProvider,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    identityProviders: IdentityProviderService
  }
}

/** Stable code for a registration whose id is already claimed. */
export const DUPLICATE_PROVIDER = 'DUPLICATE_PROVIDER'

/** Stable code for a registration whose id or scopes are invalid. */
export const INVALID_PROVIDER = 'INVALID_PROVIDER'

/**
 * Structured identity-provider failure with a stable `code` (`DUPLICATE_PROVIDER`,
 * `INVALID_PROVIDER`) that callers route on instead of parsing `message`.
 */
export class IdentityProviderError extends Error {
  /** Stable machine-routable failure class. */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

/**
 * Narrow an arbitrary thrown value to an {@link IdentityProviderError}.
 * @param value - the caught value (`unknown` in catch clauses).
 * @returns true only for real instances; duck-typed or cross-realm errors do not narrow.
 */
export function isIdentityProviderError(value: unknown): value is IdentityProviderError {
  return value instanceof IdentityProviderError
}

/**
 * `ctx.identityProviders`. Holds the id-to-adapter registry; each entry is published and
 * cleared by the registering fiber, so an adapter never outlives the plugin that registered it.
 */
export class IdentityProviderService extends Service {
  private readonly providers = new Map<string, IdentityProvider>()

  constructor(ctx: Context) {
    super(ctx, 'identityProviders')
  }

  /**
   * Register one identity adapter under a stable id. One adapter owns one id: a second
   * registration under the same id would let two plugins resolve the same `providerId` to
   * different identities.
   * @param id - the registry key, equal to the adapter's own `id` and the `providerId` every
   *   resolved identity carries.
   * @param adapter - the provider to register.
   * @returns a synchronous disposer withdrawing the registration.
   * @throws {IdentityProviderError} code `INVALID_PROVIDER` when the id is empty, the adapter
   *   declares no scopes, or the adapter's `id` does not match; code `DUPLICATE_PROVIDER` when
   *   the id is already claimed.
   */
  register(id: string, adapter: IdentityProvider): () => void {
    const dispose = this.ctx.effect(function* (this: IdentityProviderService) {
      if (id.trim() === '') {
        throw new IdentityProviderError('an identity provider id must be a non-empty string', INVALID_PROVIDER)
      }
      if (adapter.id !== id) {
        throw new IdentityProviderError(
          `an identity provider registered as "${id}" must declare the same adapter id; found "${adapter.id}"`,
          INVALID_PROVIDER,
        )
      }
      if (adapter.scopes.length === 0) {
        throw new IdentityProviderError(`identity provider "${id}" declares no scopes`, INVALID_PROVIDER)
      }
      if (this.providers.has(id)) {
        throw new IdentityProviderError(`an identity provider with id "${id}" is already registered`, DUPLICATE_PROVIDER)
      }
      this.providers.set(id, adapter)
      yield () => {
        this.providers.delete(id)
      }
    }.bind(this), 'identityProviders.register()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is synchronous fire-and-forget.
    return () => void dispose()
  }

  /**
   * Every registered provider id, in registration order.
   * @returns one id per registered adapter.
   */
  list(): readonly string[] {
    return [...this.providers.keys()]
  }

  /**
   * One registered adapter.
   * @param id - the provider id to resolve.
   * @returns the adapter, or undefined when no provider claims that id.
   */
  get(id: string): IdentityProvider | undefined {
    return this.providers.get(id)
  }
}

export default IdentityProviderService
