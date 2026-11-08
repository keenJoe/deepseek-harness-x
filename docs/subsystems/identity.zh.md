# Identity

[English](identity.md) | 中文

身份提供方 seam —— 一个 [capability seam](../glossary.zh.md#capability-seam)，暴露一个 `ctx.identityProviders` 注册表，用于存放部署所选定的 OIDC/SSO 身份适配器。Service Definition（[dsh-identity-providers](../../packages/identity/identity-providers)）拥有 `ctx.identityProviders` 和 id 到适配器的注册表；与提供方无关的适配器契约位于 [dsh-identity-protocol](../../packages/identity/identity-protocol)。一个提供方插件为每个身份源注册一个适配器，托管登录流程通过选定的适配器解析浏览器回调。身份是**一项可选能力**，不属于 agent-loop 主干 —— 因此它的词汇放在这里，而不是 [core.md](core.zh.md)。未注册任何适配器的部署保留内置的单用户 loopback。

Source: [`packages/identity/identity-protocol/src/types.ts`](../../packages/identity/identity-protocol/src/types.ts)

<a id="adapter-contract"></a>

## Adapter contract

每个适配器声明一个稳定的 `id` —— 它是注册表键，同时也是记录在解析后身份上的 `providerId` —— 它请求的 `scopes`，以及登录流程驱动的 `authorizationUrl`/`exchange` 对。seam 不构建重定向也不执行交换，因此它同样承载通用 OIDC、飞书/Lark、GitHub 和 DeepSeek Platform。

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

注册是原子的：`register()` 在变更前校验 id、它与适配器自身 `id` 的一致性以及声明的 scopes，因此无效或冲突的注册不发布任何内容，其 disposer 连同注册 fiber 一起释放 id。`list()` 按注册顺序报告 id，`get()` 按 id 解析一个；两者都从活动注册表回答。`IdentityProviderError` 继承普通 `Error`，带有稳定码 `INVALID_PROVIDER` 和 `DUPLICATE_PROVIDER`，调用方据此路由而不是解析 `message`。选择发生在托管登录流程中：浏览器指定一个已注册的 `provider` id。[dsh-identity-provider-oidc](../../packages/identity/identity-provider-oidc) 是已发布的 OpenID Connect 适配器 —— 它解析一个部署 issuer 的端点，并把授权码换成经过校验的 `id_token`；[dsh-identity-provider-feishu](../../packages/identity/identity-provider-feishu) 通过飞书开放平台让浏览器登录，用授权码换取 `user_access_token` 并从用户信息端点读取用户。两行均出厂即禁用。

<a id="enabling-hosted-login"></a>

### 启用托管登录

部署通过启用 Web 组装中出厂即禁用的 `identity-oidc` 行来打开登录，并填入自己的 issuer、client id 与可选 client secret：[apps/cli/config/examples/multi-user-oidc.yml](../../apps/cli/config/examples/multi-user-oidc.yml) 从 `DSH_OIDC_ISSUER`、`DSH_OIDC_CLIENT_ID`、`DSH_OIDC_CLIENT_SECRET` 与 `DSH_OIDC_DEFAULT_TENANT` 读取这些值，部署用 `dsh web --patch` 传入它。一旦注册了适配器，任何没有会话的浏览器首页请求都会被重定向到 `/login`，授权码流程在该 issuer 上完成，之后每个被放行的浏览器都以 `user` principal 而不是操作者身份发言；未注册任何适配器的组装保持单用户 loopback 不变。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
