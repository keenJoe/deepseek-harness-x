---
description: "The identity package group: the per-harness-home anonymous id shared by telemetry, feedback, and DeepSeek provider requests, the provider-neutral identity contract, the OIDC/SSO provider registry, the deployment-configured OpenID Connect adapter, and the logged-in user principal."
kind: "package-group"
---

# identity/ — shared identity

English | [中文](README.zh.md)

## Summary

The identity group counts one anonymous installation per harness home for telemetry, feedback, and DeepSeek requests. `identity-protocol` adds the provider-neutral OAuth identity contract and canonical ACL key codec. `identity-providers` adds the registry of deployment-selected OIDC/SSO adapters that hosted login resolves. `identity-provider-oidc` adds the deployment-configured OpenID Connect adapter for one issuer. `user-principal` adds the logged-in `user` principal and branded `UserId` the hosted connection layer partitions on. `identity-provider-feishu` adds the Feishu Open Platform adapter for one app. The group has six packages; each README owns its details.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`anonymous-user-id`](anonymous-user-id/README.md) | Gives every harness home one anonymous id that telemetry, feedback, and DeepSeek requests attach to their records, so records from one installation can be recognized without identifying the user |
| [`identity-protocol`](identity-protocol/README.md) | Provider-neutral OAuth identity contract and canonical ACL key codec shared by the owner bundle and the Relay |
| [`identity-providers`](identity-providers/README.md) | Registry of deployment-selected OIDC/SSO identity adapters that hosted multi-user login resolves |
| [`identity-provider-oidc`](identity-provider-oidc/README.md) | Deployment-configured OpenID Connect adapter that registers one issuer on `ctx.identityProviders` and exchanges an authorization code for a verified id_token |
| [`identity-provider-feishu`](identity-provider-feishu/README.md) | Deployment-configured Feishu Open Platform adapter that exchanges a code for a user access token and resolves the signed-in person |
| [`user-principal`](user-principal/README.md) | Logged-in `user` principal, branded `UserId` partition key, and the durable-root helpers per-user stores resolve through |

<a id="related-documentation"></a>
## Related documentation

- [Identity subsystem](../../docs/subsystems/identity.md) — the provider-neutral identity contract and the `ctx.identityProviders` registry.
- [Session telemetry subsystem](../../docs/subsystems/session-telemetry.md) — the telemetry feature that carries the id on exports.
- [dsh-llm-deepseek](../llm/llm-deepseek/README.md) — the DeepSeek provider that carries the id on requests.
- [dsh-command-feedback](../feedback/command-feedback/README.md) — the feedback command that names the anonymous installation in its acknowledgement.

<a id="dev-note"></a>
## Dev Note

None.
