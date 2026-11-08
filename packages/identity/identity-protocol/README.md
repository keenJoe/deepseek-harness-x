---
description: "Provider-neutral OAuth identity contract and canonical ACL key codec shared by the owner bundle and the Relay."
kind: "package-library"
---

# @deepseek-ai/dsh-identity-protocol

English | [中文](README.zh.md)

## Summary

`dsh-identity-protocol` gives the Liveshare owner bundle and the Relay one provider-neutral OAuth identity contract: the `IdentityTriple` that names one person, the browser authorization and exchange interface a deployment's identity adapter implements, and the canonical `providerId:tenantId:subjectId` ACL key codec every adapter applies before an identity is stored. It owns no credential storage, HTTP client, or runtime state, so both consumers share one dependency-free copy. The root entry exports the types and key helpers; the loopback `MockIdentityProvider` stays reachable only through `./src/*` for tests and local runs.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Import this package whenever code must name one identity or compare two: the owner host that stores share ACLs, the Relay that resolves a viewer before admission, and an identity adapter that turns a provider callback into an actor. Reach for the key codec rather than composing `providerId + tenantId + subjectId` by hand, because the codec also applies percent-encoding and the empty-tenant rule.

### Entry point

```ts
import { identityFromKey, identityKeyOf, normalizeIdentity } from '@deepseek-ai/dsh-identity-protocol'
```

`identityKeyOf` renders a normalized actor as the stable key every ACL comparison uses; `identityFromKey` parses that key back and answers `undefined` for a non-canonical input; `normalizeIdentity` fills the documented `default` tenant for a provider that issues none. The types (`IdentityTriple`, `IdentityActor`, `IdentityProvider`, and the authorization and exchange requests) describe the browser OAuth contract an adapter implements. The loopback `MockIdentityProvider` is for tests and local runs only: import it from `@deepseek-ai/dsh-identity-protocol/src/mock` and keep it out of published call paths.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`types.ts` declares the identity triple, the resolved actor, the browser authorization and exchange requests, and the `IdentityProvider` interface. `keys.ts` owns the canonical key codec and the tenant normalization every adapter applies before an identity is stored. `mock.ts` implements `IdentityProvider` against a fixed persona list for deterministic tests; the root entry re-exports only `types` and `keys`, never the mock.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Root entry re-exporting the identity types and key codec |
| [`src/types.ts`](src/types.ts) | Provider-neutral identity triple, actor, and `IdentityProvider` contract |
| [`src/keys.ts`](src/keys.ts) | Canonical ACL key codec and tenant normalization |
| [`src/mock.ts`](src/mock.ts) | Loopback identity provider for tests and local runs; reachable through `./src/*` only |

### Why it stays dependency-free

The identity contract needs no Cordis services, sockets, or storage: a triple is a plain value, the key codec is a pure function over strings, and the mock provider only builds `URL` and `Promise` values. Keeping the package dependency-free means the owner bundle and the Relay can each install an interchangeable copy without importing an unrelated capability.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the consumers that store or resolve these identities.

- [Liveshare protocol](../../experimental/liveshare-protocol/README.md) — re-exports this contract from its root for the owner bundle and the Relay.
- [identity package group](../README.md) — the group that lists this package.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- `MockIdentityProvider` resolves a fixed persona list into an actor and performs no real authentication; it exists for tests and local runs only, and a deployment must implement `IdentityProvider` against a real OAuth provider before any identity reaches a production admission path.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
