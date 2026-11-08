---
description: "Adds a deployment-configured Feishu Open Platform identity provider that resolves the hosted Web login to one signed-in person."
kind: "package-bundle"
---

# @deepseek-ai/dsh-identity-provider-feishu

English | [中文](README.zh.md)

## Summary

`dsh-identity-provider-feishu` registers one Feishu Open Platform identity provider on the `ctx.identityProviders` seam, so a hosted Web profile signs a browser in at Feishu and admits the session once the signed-in person is resolved. The row ships disabled: an app id and app secret are deployment facts, so a profile patch enables it with that configuration. Feishu returns no `id_token`, so the adapter exchanges the authorization code for a `user_access_token` and reads the person from the user-info endpoint; the resolved identity keys on the Feishu `open_id` and the tenant key.

## Table of Contents

- [Use this package](#use-this-package)
- [Config](#config)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Model Experience](#model-experience)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable the `identity-provider-feishu` row in a profile that already mounts the Web server and the identity-provider registry:

```yaml
- id: identity-provider-feishu
  disabled: false
  config:
    id: feishu
    appId: cli_xxxxxxxx
    appSecret: your-app-secret
```

The config `id` is the registry id: it selects the provider in `?provider=`, keys it in the registry, and becomes the `providerId` every resolved identity carries.

<a id="config"></a>
## Config

| Key | Default | Meaning |
|---|---|---|
| `id` | Required | Registry id and the `providerId` recorded on every resolved identity. |
| `appId` | Required | Feishu Open Platform app id (`app_id`). |
| `appSecret` | — | Feishu app secret, read per exchange so a rotation applies without a reload. |
| `scopes` | `['contact:user.base:readonly']` | Scopes the browser authorization requests; the app must be granted them. |
| `baseUrl` | `https://open.feishu.cn/open-apis/` | Feishu or Lark API base; a Lark deployment supplies its own host. |
| `requestTimeoutMs` | `30000` | Deadline for each token and user-info request. |
| `defaultTenant` | — | Tenant id used when the user-info response carries no tenant key. |

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The adapter performs no local signature check: Feishu issues no `id_token`, so the HTTPS token endpoint authenticated by `app_secret` is the authority.
- The authorization redirect does not forward a PKCE challenge; Feishu authenticates the token request with the app secret instead.
- The app must be granted `contact:user.base:readonly` (or the configured scopes) and its redirect URI must be registered in the Feishu console.

<a id="model-experience"></a>
## Model Experience

None. Login runs in the browser and the resolved identity never reaches a model request.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
