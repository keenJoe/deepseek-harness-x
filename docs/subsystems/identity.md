# Identity

English | [中文](identity.zh.md)

The identity-provider seam — a [capability seam](../glossary.md#capability-seam) exposing one `ctx.identityProviders` registry of deployment-selected OIDC/SSO identity adapters. The Service Definition ([dsh-identity-providers](../../packages/identity/identity-providers)) owns `ctx.identityProviders` and the id-to-adapter registry; the provider-neutral adapter contract lives in [dsh-identity-protocol](../../packages/identity/identity-protocol). A provider plugin registers one adapter per identity source, and the hosted login flow resolves a browser callback through a selected adapter. Identity is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A deployment that registers no adapter keeps the built-in single-user loopback.

Source: [`packages/identity/identity-protocol/src/types.ts`](../../packages/identity/identity-protocol/src/types.ts)

<a id="adapter-contract"></a>

## Adapter contract

Every adapter declares a stable `id` — the registry key that is also the `providerId` recorded on a resolved identity — the `scopes` it requests, and the `authorizationUrl`/`exchange` pair the login flow drives. The seam builds no redirect and performs no exchange, so it hosts generic OIDC, 飞书/Lark, GitHub, and DeepSeek Platform alike.

```ts type-equiv
/** Provider, tenant, and subject triple that identifies one person across providers. */
interface IdentityTriple {
  /** Identity provider that owns the subject. */
  readonly providerId: string
  /** Provider tenant that contains the subject. */
  readonly tenantId: string
  /** Provider-scoped subject id. */
  readonly subjectId: string
}
```

```ts type-equiv
/** Provider-neutral viewer identity resolved by a Relay. */
interface IdentityActor extends IdentityTriple {
  readonly displayName: string
  /**
   * Provider-issued avatar URL, when the provider publishes one. Presentation only: it carries no
   * credential, and a provider that issues none leaves it absent rather than inventing a value.
   */
  readonly avatarUrl?: string
}
```

```ts type-equiv
/** Request facts needed to build one provider authorization redirect. */
interface IdentityAuthorizationRequest {
  /** State value the login flow minted; the provider echoes it back unchanged. */
  readonly state: string
  /** Callback URL the provider must redirect to after authorization. */
  readonly redirectUri: string
  /** Scopes the login flow requests. */
  readonly scopes: readonly string[]
  /** Hint for selecting one login identity; absent for a provider that needs none. */
  readonly loginHint?: string
  /** PKCE S256 code challenge the provider redirect includes; absent for a provider that uses no PKCE. */
  readonly codeChallenge?: string
  /** PKCE challenge method, always S256 when a code challenge is present. */
  readonly codeChallengeMethod?: 'S256'
}
```

```ts type-equiv
/** Request facts needed to exchange a provider callback code. */
interface IdentityExchangeRequest {
  /** Authorization code the provider issued at its callback. */
  readonly code: string
  /** State value the login flow minted and the provider echoed back unchanged. */
  readonly state: string
  /** Callback URL the exchange repeats to the provider. */
  readonly redirectUri: string
  /** PKCE S256 code verifier the login flow minted; absent for a provider that uses no PKCE. */
  readonly codeVerifier?: string
}
```

```ts type-equiv
/** Generic browser OAuth contract a deployment's identity adapter implements; the protocol's mock implements it for local runs. */
interface IdentityProvider {
  readonly id: string
  readonly scopes: readonly string[]
  authorizationUrl(request: IdentityAuthorizationRequest): URL
  exchange(request: IdentityExchangeRequest): Promise<IdentityActor>
}
```

<a id="registration-and-selection"></a>

## Registration and selection

Registration is atomic: `register()` validates the id, its match with the adapter's own `id`, and the declared scopes before mutating, so an invalid or conflicting registration publishes nothing, and its disposer releases the id together with the registering fiber. `list()` reports ids in registration order and `get()` resolves one by id; both answer from the live registry. `IdentityProviderError` extends plain `Error` with stable codes `INVALID_PROVIDER` and `DUPLICATE_PROVIDER` that callers route on instead of parsing `message`. Selection happens in the hosted login flow: the browser names one registered `provider` id. [dsh-identity-provider-oidc](../../packages/identity/identity-provider-oidc) is the shipped OpenID Connect adapter — it resolves one deployment issuer’s endpoints and exchanges an authorization code for a verified `id_token` — and [dsh-identity-provider-feishu](../../packages/identity/identity-provider-feishu) signs a browser in through the Feishu Open Platform, exchanging the code for a `user_access_token` and reading the person from user-info. Both rows ship disabled.

<a id="enabling-hosted-login"></a>

### Enabling hosted login

A deployment turns login on by enabling the `identity-oidc` row the Web composition ships disabled with its own issuer, client id, and optional client secret: [apps/cli/config/examples/multi-user-oidc.yml](../../apps/cli/config/examples/multi-user-oidc.yml) reads them from `DSH_OIDC_ISSUER`, `DSH_OIDC_CLIENT_ID`, `DSH_OIDC_CLIENT_SECRET`, and `DSH_OIDC_DEFAULT_TENANT`, and a deployment passes it with `dsh web --patch`. Once an adapter is registered every browser index request without a session is redirected to `/login`, the authorization code flow runs against that issuer, and each admitted browser speaks as a `user` principal instead of the operator; a composition that registers no adapter keeps the single-user loopback unchanged.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxidentityproviders--identityproviderservice"></a>

### `ctx.identityProviders` — `IdentityProviderService`

`ctx.identityProviders`. Holds the id-to-adapter registry; each entry is published and cleared by the registering fiber, so an adapter never outlives the plugin that registered it.

```ts cordis-catalog
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
register(id: string, adapter: IdentityProvider): () => void

/**
 * Every registered provider id, in registration order.
 * @returns one id per registered adapter.
 */
list(): readonly string[]

/**
 * One registered adapter.
 * @param id - the provider id to resolve.
 * @returns the adapter, or undefined when no provider claims that id.
 */
get(id: string): IdentityProvider | undefined
```

Source: [`packages/identity/identity-providers/src/index.ts`](../../packages/identity/identity-providers/src/index.ts)
<!-- END GENERATED cordis-surface -->
