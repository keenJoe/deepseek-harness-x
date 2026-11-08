---
description: "The identity-provider registry for hosted multi-user login: deployment-selected OIDC/SSO adapters that resolve each browser sign-in to one logged-in user."
kind: "package-reference"
---

# @deepseek-ai/dsh-identity-providers

English | [中文](README.zh.md)

## Summary

`dsh-identity-providers` lets a hosted deployment sign people in through one or more OIDC or SSO identity providers instead of the built-in single-user loopback. You mount one provider plugin per identity source and register its adapter under a stable id; the login flow then resolves each browser callback to that logged-in person. Choose it when distinct people must see only their own work. The package ships no provider of its own, and a deployment that enables none keeps the single-user loopback.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This package is the part of the product that holds the identity sources a hosted login offers: a provider plugin registers one adapter per identity source, and the login flow resolves a browser callback through that adapter. The common path is explicit — register an adapter for each identity source your deployment offers, then let the login flow select one by id.

### When to use it

Use it whenever a deployment must let distinct people log in through pluggable identity providers — generic OIDC, 飞书/Lark, GitHub, DeepSeek Platform, or a mock for local runs — so each person sees only their own work. If a deployment runs single-user, mount nothing against this seam: with no adapter registered it stays inert and the built-in single-user loopback is unchanged. A provider plugin is optional, so the deployment opts into exactly the sources it needs.

### Registering a provider

A provider plugin declares one adapter per identity source, keyed by the id that is also the `providerId` recorded on every resolved identity:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { IdentityActor, IdentityProvider } from '@deepseek-ai/dsh-identity-providers'

declare const ctx: Context
declare const exchangeWithIssuer: (code: string, redirectUri: string) => Promise<IdentityActor>

const adapter: IdentityProvider = {
  id: 'example-oidc',
  scopes: ['openid', 'profile'],
  authorizationUrl(request) {
    const url = new URL('https://idp.example/authorize')
    url.searchParams.set('client_id', 'client')
    url.searchParams.set('redirect_uri', request.redirectUri)
    url.searchParams.set('state', request.state)
    url.searchParams.set('scope', request.scopes.join(' '))
    return url
  },
  async exchange(request) {
    return exchangeWithIssuer(request.code, request.redirectUri)
  },
}

const dispose = ctx.identityProviders.register('example-oidc', adapter)

ctx.identityProviders.list()              // ['example-oidc', ...] in registration order
ctx.identityProviders.get('example-oidc') // the adapter above, or undefined
dispose()                                 // unregister the adapter
```

An adapter declares a stable id, the scopes it requests, and the authorization/exchange methods that turn a callback into a logged-in identity. The registered id must be non-empty, match the adapter's own id, and the adapter must declare at least one scope; a registration that fails any check throws `IdentityProviderError` with code `INVALID_PROVIDER` before anything is published. Registering the same id twice throws `DUPLICATE_PROVIDER`. `list()` reports the ids in registration order and `get()` resolves one by id, both from the live registry, so a disposed adapter stops appearing immediately.

### What can go wrong

- **An empty or mismatched id fails registration** — `INVALID_PROVIDER`, so the registry key and the `providerId` every resolved identity carries always agree.
- **An adapter with no scopes fails registration** — `INVALID_PROVIDER`, so a sign-in never asks for something the deployment did not review.
- **Registering the same id twice throws `DUPLICATE_PROVIDER`** — one adapter owns one id, and a login binds to exactly that provider.
- **No registered adapter is inert, not an error** — with an empty registry the login flow keeps the single-user loopback; only a deployment that enables a provider changes behavior.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the seam and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **The seam owns the registry, never the protocol.** A deployment's identity source arrives as a plugin that registers an adapter; a second protocol arrives as another adapter rather than another seam, and the login flow selects an adapter without knowing its protocol.
- **The adapter contract is provider-neutral.** An adapter declares a stable id, the scopes it requests, and the `authorizationUrl`/`exchange` pair the login flow drives; the seam builds no redirect and performs no exchange, so it hosts generic OIDC, 飞书/Lark, GitHub, and DeepSeek Platform alike.
- **Registration is atomic.** `register()` validates and conflict-checks before mutating: an invalid or conflicting registration publishes nothing, and its disposer releases the id together with the registering fiber.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition: id-to-adapter registry, `register`/`list`/`get`, `IdentityProviderError` codes |
| [`src/types.ts`](src/types.ts) | Adapter contract re-exported from `dsh-identity-protocol` |

### Registration lifecycle

Registration and disposal run through `ctx.effect()`, so a provider lives and dies with the registering fiber. `IdentityProviderError` extends plain `Error` with stable codes (`INVALID_PROVIDER`, `DUPLICATE_PROVIDER`) that callers route on instead of parsing `message`; `isIdentityProviderError` narrows a caught value to that error at runtime boundaries. The seam extends plain `Error` rather than a heavier error base so the identity group keeps its dependency-light posture.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared identity contract to the principal that resolves and partitions on it.

- [Identity package group](../README.md) — the group map for this registry, the identity contract, and the logged-in user principal.
- [dsh-identity-protocol](../identity-protocol/README.md) — the provider-neutral `IdentityProvider` contract this registry re-exports.
- [dsh-user-principal](../user-principal/README.md) — the logged-in `user` principal and canonical `UserId` the login flow resolves.
- [Capability seams](../../../docs/capability-seams.md) — the Service Definition / Service Provider / Consumer split this seam follows.
- [Hosted multi-user Web](../../../.agents/notes/implemented/architecture/2026-11-05-hosted-multi-user-oidc-tenant-isolation.md) — the design this seam is one stage of.

-----

<a id="model-experience"></a>
## Model Experience

None, as the registry holds provider adapters for the host login flow and no adapter, provider, or login state reaches a model request.

#### KV Cache effect

No invalidation; no login or identity state enters a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **No built-in provider** — the registry holds only what provider plugins mount; a deployment that mounts none keeps the single-user loopback, and a hosted login needs at least one provider package.
- **Registration is runtime-only** — the enabled provider set comes from whichever plugins mount and call `register()`; the registry reads no configuration and selects no default itself.
- **No session or token storage** — the registry holds adapters, never login sessions or IdP grants; persistence and revocation belong to the browser-session layer and the credential seam.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
