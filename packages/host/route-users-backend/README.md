---
description: "Verifies the entry-signed caller header so a per-user backend admits entry-authenticated requests."
kind: "package-library"
---

# @deepseek-ai/dsh-route-users-backend

English | [中文](README.zh.md)

## Summary

`dsh-route-users-backend` is the backend half of the trusted-forwarder seam. It provides `ctx.connectionTrust` with a verifier for the entry-signed caller header, so a per-user backend admits requests an entry process already authenticated without ever holding the login cookie key. A request without a valid, fresh forwarding proof is refused by Connection itself.

## Table of Contents

- [Use this package](#use-this-package)
- [Config](#config)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Model Experience](#model-experience)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it on each per-user backend with the same `forwardSecret` the entry router signs with:

```yaml
- id: route-users-backend
  name: '@deepseek-ai/dsh-route-users-backend'
  config:
    forwardSecret: !!js process.env.DSH_FORWARD_SECRET

```

The backend still mounts `client-connection`; this plugin only supplies the trust context the connection layer consults first.

<a id="config"></a>
## Config

| Key | Default | Meaning |
|---|---|---|
| `forwardSecret` | Required | Shared forwarding secret, equal to the entry router’s `forwardSecret`. |

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- A forwarded proof expires after five seconds; the entry re-signs each request, so this only bounds replay, not legitimate traffic.
- The secret is shared between the entry and every backend; rotate it by restarting the fleet.

<a id="model-experience"></a>
## Model Experience

None. Trust runs on the HTTP surface and never reaches a model request.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
