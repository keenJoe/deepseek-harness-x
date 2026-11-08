---
description: "Logged-in user principal and canonical user id for per-user isolation in DeepSeek Harness."
kind: "package-library"
---

# @deepseek-ai/dsh-user-principal

English | [中文](README.zh.md)

## Summary

`dsh-user-principal` gives the hosted multi-user connection layer one caller identity value: the `user` principal that names a logged-in user by a provider-neutral identity triple, the branded `UserId` partition key that scopes every per-user session, workspace, credential, and attachment, and the durable-root helpers every per-user store resolves through. A deployment's identity adapter resolves the triple at login; this package normalizes it and copies only the triple, the display name, and an optional avatar, so no credential reaches a Session log. It registers nothing and owns no storage.

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

Import this package wherever code mints the `Principal` a Peer speaks for after a login, or where code must name or compare two logged-in users: the hosted connection layer that turns an identity adapter's actor into a Peer, and the remote-access policy that confines each `user` to their own resources. Reach for `userId` rather than composing the triple by hand, because it applies the canonical key codec with its percent-encoding and empty-tenant rule.

### Entry point

```ts
import { callerOf, callerRoot, isWithinRoot, isUser, operatorRoot, userOf, userId, userPrincipal, userRoot } from '@deepseek-ai/dsh-user-principal'
```

`userPrincipal` normalizes an `IdentityActor` and returns the `user` principal, or `undefined` when the provider or subject id is empty; `userOf` narrows any `Principal` to that kind; `isUser` compares by the whole identity key; `userId` renders the branded canonical key every per-user path partitions on. The `UserPrincipal` and `UserId` types describe the value and its partition key.

`callerOf` reads the logged-in caller of the current Remote invocation and resolves `undefined` for the operator and for trusted in-process code; `callerRoot` returns the durable root that caller owns, appending the segments a store names, and falls back to the operator home for those callers; `userRoot` and `operatorRoot` name one of those two roots explicitly; `isWithinRoot` classifies an absolute path against a root at a path-separator boundary, so `users/alice-2` never matches `users/alice`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`index.ts` augments the merge-extensible `PrincipalMap` from `@deepseek-ai/dsh-typert-protocol` with the `user` kind, then builds that value from an `IdentityActor` by normalizing the tenant and copying each field one by one. The `UserId` brand wraps the `identityKeyOf` output from `@deepseek-ai/dsh-identity-protocol`, so the partition key stays identical to the ACL key the owner bundle and the Relay already share.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Root entry augmenting `PrincipalMap` and exporting the builders, narrowers, and the `UserId` brand |

### Why it is a plain module

The `user` principal is a JSON value with a unique literal `kind` and no credential, so it is safe to persist in Session logs and needs no Cordis registration, socket, or storage to build. Keeping the package a plain library lets the connection layer and the remote-access policy import the same value without mounting a plugin.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the identity contract this value wraps or the consumers that mint it.

- [Identity protocol](../identity-protocol/README.md) — the provider-neutral triple and canonical key codec this package wraps.
- [identity package group](../README.md) — the group that lists this package.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- `userPrincipal` accepts any `IdentityActor` and performs no authentication; the identity adapter that resolved the actor owns that boundary, and no Peer should be minted from an unauthenticated actor.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
