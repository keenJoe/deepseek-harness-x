---
description: "Routes each signed-in browser to its own harness backend from one entry URL."
kind: "package-library"
---

# @deepseek-ai/dsh-route-users

English | [中文](README.zh.md)

## Summary

`dsh-route-users` is an identity-aware reverse proxy for hosted multi-user Web. The entry Web process owns the login routes, and this plugin owns the webserver fallback: after a browser signs in, its unmatched requests are forwarded to the per-user backend that owns its harness home. The proxy never mints an identity itself — it reads the caller through the mounted Connection service and maps the canonical `userId` to a backend port. A request with no session is refused with 401, and a user with no backend with 502.

## Table of Contents

- [Use this package](#use-this-package)
- [Config](#config)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Model Experience](#model-experience)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it in the entry Web composition that already owns `webServer`, `connection`, and the identity-provider registry, with one port per canonical user key:

```yaml
- id: route-users
  name: '@deepseek-ai/dsh-route-users'
  config:
    ports:
      'feishu:tenant-7:ou_42': 3080

```

The key is the canonical `userId` (`provider:tenant:subject`). Requests to `/login` and the other exact connection routes still answer at the entry; every other request is admitted through the session cookie and forwarded to the matching backend.

<a id="config"></a>
## Config

| Key | Default | Meaning |
|---|---|---|
| `ports` | Required | Canonical user key to loopback port mapping. A request is refused 502 when its user has no entry. |

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The router streams HTTP but does not re-write absolute redirects or WebSocket upgrades; a deployment that needs those hosts the backends under one authority instead.
- Hop-by-hop headers are stripped; the backend must accept the entry as the client authority.

<a id="model-experience"></a>
## Model Experience

None. Routing runs on the HTTP surface and never reaches a model request.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
