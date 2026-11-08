---
description: "Adds a deployment-configured OpenID Connect identity provider that resolves the hosted Web login to one verified person."
kind: "package-bundle"
---

# @deepseek-ai/dsh-identity-provider-oidc

English | [中文](README.zh.md)

## Summary

`dsh-identity-provider-oidc` registers one OpenID Connect identity provider on the `ctx.identityProviders` seam, so a hosted Web profile signs a browser in at the deployment's issuer and admits the session only after the returned `id_token` verifies locally. The row ships disabled: an issuer and a client id are deployment facts, so a profile patch enables it with that configuration. Registering a provider changes browser admission, because an unauthenticated browser is sent to the login route instead of receiving owner access. Only RS256-signed tokens are accepted, and an issuer key rotation needs a plugin reload.

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

### Enable the row

[`cordis.patch.yml`](cordis.patch.yml) inserts the `identity-provider-oidc` row with `disabled: true` and no configuration, because an issuer and a client id belong to the deployment. Enable it by overriding that entry with `disabled: false` and its own `config` in the profile patch, in a profile that already mounts the Web server and the identity-provider registry.

```yaml
- id: identity-provider-oidc
  disabled: false
  config:
    id: corporate
    issuer: https://login.example.com
    clientId: dsh-web
    defaultTenant: example
```

The config `id` is the registry id: it selects the provider in `?provider=`, keys it in the registry, and becomes the `providerId` every resolved identity carries. The Cordis entry id stays `identity-provider-oidc`.

### Config

| Key | Default | Meaning |
|---|---|---|
| `id` | Required | Registry id and the `providerId` recorded on every resolved identity. A second registration under the same id is refused. |
| `issuer` | Required | Expected `id_token` `iss` value and the base of the discovery document. |
| `clientId` | Required | OAuth client id. |
| `clientSecret` | — | Optional secret. When set, the token request authenticates with HTTP Basic (`client_secret_basic`); leave it unset for a public client. The value is read for each exchange, so a rotation applies without a reload. |
| `scopes` | `['openid', 'profile', 'email']` | Scopes the browser authorization requests. |
| `authorizationEndpoint` | Discovered | Authorization endpoint. Configure it together with `tokenEndpoint` and `jwksUri`; otherwise all three come from the discovery document. |
| `tokenEndpoint` | Discovered | Token endpoint, part of the same all-or-nothing set. |
| `jwksUri` | Discovered | JWKS endpoint whose key verifies the `id_token`, part of the same all-or-nothing set. |
| `requestTimeoutMs` | `30000` | Deadline for each issuer, JWKS, and token request. |
| `defaultTenant` | — | Tenant id used when the token carries no tenant claim. |
| `tenantClaim` | — | `id_token` claim that names the tenant. |

Without all three endpoint keys, the plugin reads `<issuer>/.well-known/openid-configuration` while it loads, so an unreachable issuer or a partial endpoint set fails the load instead of the first login, and the discovered `issuer` must equal the configured value. When neither `tenantClaim` nor `defaultTenant` resolves a tenant, the login is refused rather than placed under a guessed tenant.

### Browser login

`GET /login?provider=<config id>` starts the flow. With exactly one registered provider, `/login` without the parameter selects it, and any other selection answers `400`. The [connection login flow](../../client/connection/README.md) mints a single-use `state` value and a PKCE S256 challenge, redirects to the issuer's authorization endpoint, and completes at `/login/callback`, which repeats the exchange with the matching code verifier. A deployment that registers a provider no longer admits an unauthenticated browser as the owner.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the disabled row. `src/index.ts` implements the provider-neutral `IdentityProvider` from the seam and registers it through `ctx.identityProviders.register(id, adapter)` inside one effect, so the registration withdraws with the loading fiber. `authorizationUrl` builds the issuer redirect from the configured `clientId` and scopes, the callback URL, the login flow's single-use `state`, and the S256 `code_challenge`; `exchange` posts the code with the matching `code_verifier` and resolves the identity. When the deployment configures no static endpoints, discovery runs in the plugin's service initialization, so loading waits for the issuer.

Verification is local. The plugin reads the issuer's JWKS once and caches it, selects the key the token header's `kid` names, and checks the `id_token` signature with `node:crypto` using RS256; it then requires `iss` to be the configured issuer, `aud` to include the `clientId`, `exp` to lie in the future, and `sub` to be present. The resolved identity takes `providerId` from the config `id`, `subjectId` from `sub`, a display name from `name`, else `preferredUsername`, else `sub`, the avatar from `picture`, and the tenant from `tenantClaim` when the claim exists, otherwise `defaultTenant`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Identity](../../identity/README.md) — the package group these identity packages belong to.
- [Identity providers](../identity-providers/README.md) — the registry this package registers into.
- [Identity protocol](../identity-protocol/README.md) — the provider-neutral authorization and exchange types this adapter implements.
- [Web bundle](../../bundle/web-app/README.md) — the stable profile whose browser admission this provider narrows.
- [Connection](../../client/connection/README.md) — the `/login` and `/login/callback` routes that drive the flow.

-----

<a id="model-experience"></a>
## Model Experience

### Browser sign-in

#### What the model sees

Nothing. The provider answers browser login requests only: it contributes no prompt section, tool schema, or result text, and the resolved `IdentityActor` reaches the browser session record instead of a model request.

#### Token effect

Zero direct tokens. A login spends no model request, and a resolved identity adds nothing to the next request.

#### KV Cache effect

Independent. No model request changes, so the package invalidates no reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The JWKS is fetched once per plugin lifetime** — an issuer that rotates its signing key stops verifying until the plugin reloads.
- **Only RS256 is accepted** — an issuer that signs `id_token`s with another algorithm is refused.
- **The row ships disabled and unconfigured** — a profile that enables it must supply its own issuer and client, and enabling it changes browser admission from owner access to a provider login.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
