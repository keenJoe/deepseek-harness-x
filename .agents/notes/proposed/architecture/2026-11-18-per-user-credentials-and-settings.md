# Agent Note: Per-user credentials and settings

Status: proposed

English | [中文](2026-11-18-per-user-credentials-and-settings.zh.md)

## Problem

The deployment decision is that every admitted person supplies their own model credential. Today the credential store is one document for the whole process, and the Remote policy refuses a logged-in user the endpoints that would write it.

`credentials-local` resolves its document as `config.path ?? <harness-home>/.credentials.yaml` ([`packages/credentials/credentials-local/src/index.ts:90`](../../../../packages/credentials/credentials-local/src/index.ts)). One process therefore has one credential document, and one person's key is the key every person's model request uses.

Even with per-user storage, a user cannot reach it. `USER_GLOBAL_ROLE` in [`packages/api/remote-access/src/user-policy.ts`](../../../../packages/api/remote-access/src/user-policy.ts) lists fourteen actions and includes neither `credentials/*` nor `settings/*`. `explainUserRefusal` reports `user/no-access` for an endpoint no role lists, so a signed-in person's Settings page cannot read or write a key at all.

Settings have a second problem. `settings` writes through `configEditor` into the profile patch ([`packages/boot/config-editor/src/index.ts:34`](../../../../packages/boot/config-editor/src/index.ts) returns `profileContext.patchPath`), which is one file per profile and is also the composition document. A per-user settings write into that file would let one person edit the composition every other person boots.

The model-selection surface makes this concrete: `agentDefaultModel` reads and writes through the same `configEditor` ([`packages/core/agent-default-model/src/index.ts:85`](../../../../packages/core/agent-default-model/src/index.ts)), so "my default model" and "the deployment's default model" are one value.

## Proposal

Three changes, in dependency order.

### 1. Resolve credentials and settings inside the caller's realm

[Per-user realm partitioning](2026-11-18-per-user-realm-partitioning.md) mounts one `credentials-local` per person with `path: userHomePath(key, '.credentials.yaml')`. The Remote namespaces `credentials` and `settings` then reach the caller's instance through the same isolation binding that routes every other private service, so no controller changes and no per-call root logic.

A call with no `user` principal keeps the root instance and the deployment document, which is what the operator and in-process callers still need.

### 2. Separate the user's settings document from the profile patch

A per-user settings write must not reach `profileContext.patchPath`. The user's `settings` instance therefore needs its own document under `userHomePath(key)`, and its `configEditor` binding must point there.

Two shapes are viable and the choice belongs with the implementation:

**A scoped document per realm.** `config-editor` accepts the document path from its owning Context instead of reading `profileContext.patchPath` unconditionally, and a realm mounts a `config-editor` bound to `userHomePath(key, 'settings.yaml')`. The Loader keeps owning the root composition; the realm's editor owns one person's values.

**An explicit user layer.** `settings` gains a second, writable layer for `user` principals that is persisted beside the person's data and merged over the profile's inherited values at read time. The profile patch stays read-only for users.

The first reuses the existing write path and inherits its conflict detection and volatile-field validation unchanged. The second keeps one composition document but adds a merge step every settings read must honor. The proposal adopts the first, because it changes no read path and the existing `SettingsConflictError` revision check keeps working per realm.

### 3. Admit the endpoints a per-user configuration page needs

`USER_GLOBAL_ROLE` gains the endpoints a person's own configuration page calls:

- `credentials/describe`, `credentials/set`, `credentials/unset`
- `settings/describe`, `settings/update`

The authorization question is not only which endpoint a user may call but which instance answers it. Both namespaces resolve inside the caller's realm, so `credentials/set` writes the caller's document. That pairing — admitted endpoint plus realm-routed instance — is the whole guarantee, and neither half is sufficient alone.

`credentials/set` must not be reachable for another user's realm by any path. The realm registry keys on the canonical user id derived from the authenticated principal, never from request arguments, so there is no argument that names a foreign realm.

### 4. Keep account-scoped state out of the user surface

`deepseek-account` streams the deployment's DeepSeek account state ([`packages/account/deepseek-account/src/index.ts`](../../../../packages/account/deepseek-account/src/index.ts)). That is one account for the deployment, not a per-person fact, and it stays owner-only: the policy continues to resolve no binding for it.

## Alternatives considered

**Keep one credential document and namespace the keys per user.** One file with `users/<key>/DEEPSEEK_API_KEY` sections would preserve a single writer and a single file-permission check. It loses the property that a user's secret is not in a document another user's process code path can read, and it needs a key-namespacing convention every future credential consumer must honor. The realm keeps the file boundary instead.

**Let users write the profile patch and attribute sections by user.** This is what `settings` does today for one owner. It fails the composition requirement: the profile patch is the boot document, and a person editing it edits what everyone boots.

**Give users the operator's model key.** It removes the per-user credential work entirely and was the obvious cheap option. It is excluded by the deployment decision that each person supplies their own, and it would make one person's usage limit or revocation indistinguishable from another's.

## Acceptance criteria

- Two users each set a model key; `users/<keyA>/.credentials.yaml` and `users/<keyB>/.credentials.yaml` each hold only their own value.
- A model request from user A resolves A's key; B's key never appears in A's request headers.
- A settings write by a user lands in that user's document and leaves the profile patch byte-identical.
- A user's Settings page lists and updates their namespaces; no namespace belonging to the deployment composition is writable by them.
- `credentials/set` with a forged realm argument cannot reach another user's document; the refusal is a policy or not-found error, not a silent write elsewhere.
- The operator principal still reads and writes the deployment document.
- A test asserts that `USER_GLOBAL_ROLE` and the realm routing agree: every newly admitted endpoint resolves a realm-scoped instance.

## Risks

**Two settings documents diverge.** A value the deployment sets and a value a person overrides need a defined precedence, or a person's page shows a value the model does not use. The merge order — deployment inherited, then user override — must be one documented rule, not resolved per namespace.

**Secret redaction now runs per realm.** `settings.describe({ redactSecrets: true })` is how the wire avoids returning a secret. A realm that leaks an unredacted descriptor returns one person's key to that person's browser, which is correct, and to any caller that reaches the realm, which is not. The redaction path stays the same code; what changes is how many instances run it.

**A user's key is unvalidated until first use.** `ctx.deepseekAuth` normalizes the stored key per request ([`packages/account/deepseek-auth/src/index.ts`](../../../../packages/account/deepseek-auth/src/index.ts)); a typo surfaces as a failed turn rather than as a rejected save. The Settings surface should verify on write so the person learns at the moment they can fix it.

**Revocation is now per person.** Clearing a deployment key used to disable every user at once. A per-user store means the operator must reach into each document to revoke, and there is no admin surface for it in this proposal.
