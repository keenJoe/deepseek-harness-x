/**
 * Identity-provider seam vocabulary: the adapter contract a deployment's IdP plugin implements
 * and registers against the `ctx.identityProviders` registry. Types only — the registry, its
 * errors, and the `DUPLICATE_PROVIDER` / `INVALID_PROVIDER` codes are runtime and live in
 * `index.ts`.
 *
 * The adapter contract is the provider-neutral `IdentityProvider` from
 * `@deepseek-ai/dsh-identity-protocol`: a stable id, the scopes it requests, and the
 * authorization/exchange methods that turn a browser callback into an `IdentityActor`.
 * Re-exported here so a provider plugin imports its whole contract from one seam entry.
 * @module @deepseek-ai/dsh-identity-providers/types
 */

export type {
  IdentityActor,
  IdentityAuthorizationRequest,
  IdentityExchangeRequest,
  IdentityProvider,
} from '@deepseek-ai/dsh-identity-protocol'
