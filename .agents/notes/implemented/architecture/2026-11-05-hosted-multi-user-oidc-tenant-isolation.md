# Agent Note: Hosted multi-user Web with a pluggable OIDC login and per-user data isolation

Status: implemented

English | [中文](2026-11-05-hosted-multi-user-oidc-tenant-isolation.zh.md)

## Problem

The Web profile was single-user by construction. Browser token authentication ([browser-token-authentication](../../implemented/architecture/2026-08-24-browser-token-authentication.md)) exchanged a launch token for a signed cookie and then admitted every authenticated browser as the shared [`browserPeer`](../../../../packages/client/connection/src/rpc-host.ts) whose principal was `{ kind: 'owner' }` ([peer-principal-and-remote-access](../../implemented/architecture/2026-10-12-peer-principal-and-remote-access.md)). One caller identity stood for the process operator, so every Session, Workspace, setting, credential, and attachment belonged to that one home and a shared server could not tell two people apart.

## Decision

Login is a three-role capability seam, and an authenticated browser is a confined `user` rather than the operator. Five package roles carry it: the identity triple, its canonical key, and the adapter interface in [`identity-protocol`](../../../../packages/identity/identity-protocol/src/index.ts); the `identityProviders` registry in [`identity-providers`](../../../../packages/identity/identity-providers/src/index.ts); the merge-extensible `user` principal and its branded `userId` in [`user-principal`](../../../../packages/identity/user-principal/src/index.ts); the OpenID Connect adapter in [`identity-provider-oidc`](../../../../packages/identity/identity-provider-oidc/src/index.ts); and the browser login routes in [`client-connection`](../../../../packages/client/connection/src/login.ts).

### Identity and admission

A `user` principal carries the provider/tenant/subject triple, a display name, and an optional avatar URL; its canonical partition key is the [`identityKeyOf`](../../../../packages/identity/identity-protocol/src/keys.ts) percent-encoded triple, branded as `userId`. [BrowserAuth](../../../../packages/client/connection/src/browser-auth.ts) still binds the cookie to this process's authority, but the signed cookie now names a durable [`browser_sessions` record](../../../../packages/client/connection/src/storage.ts) holding the whole principal, its key, the provider, the issued and expiry instants, and the single-use OAuth state; admission mints one Peer per record. `/login?provider=<id>` starts an authorization with a single-use state and PKCE S256, `/login/callback` consumes that state and exchanges the code through the registered adapter, and `/logout` deletes the record so the next request is refused.

`owner` now names only the process operator, the local single-user profile, and trusted in-process code, and `principalOf(invocation)` keeps returning `undefined` for it, so every existing non-owner path applies to a `user` unchanged.

### The OIDC adapter

[`dsh-identity-provider-oidc`](../../../../packages/identity/identity-provider-oidc/src/index.ts) implements the adapter over a discovery document or three explicit endpoints, verifies the returned id_token with RS256 against the issuer's published keys, and checks issuer, audience, expiry, and subject before it resolves a tenant from the configured claim or default. It authenticates the token request with HTTP Basic when a client secret is configured, reading the secret per exchange so a rotated value applies without a reload. A deployment supplies `issuer` and `clientId` plus optionally the endpoints, scopes, a tenant claim, and a default tenant; the bundle ships the row `disabled: true`, so a deployment that enables no provider keeps the single-user loopback behavior.

### Per-user scoping

[`home-paths`](../../../../packages/util/home-paths/src/index.ts) gained `userHomePath(userKey, ...segments)` — the `<DSH_HOME>/users/<userKey>` root — and the opt-in `migrateLegacyRootToUser(legacyRoot, targetUserRoot)` migration, which renames every legacy child into the per-user root and refuses before touching anything when a destination child already exists.

[`SessionQueryEngine`](../../../../packages/session-query/session-query/src/index.ts) resolves its caller through `principalOf(ctx.invocation)` and confines listing, exact reads, filtering, tracing, and projections to persisted records whose materialized location sits under the caller's root; a `user` gets no live sessions and no record without a location. [`WorkspaceRegistry`](../../../../packages/workspace/workspace/src/index.ts) stamps `owner` on created workspaces, confines `get`, `list`, the archive and pin getters, and every mutation to records carrying the caller's key, and answers `workspacesOwnedBy` and `sessionsOwnedBy` so an access policy binds ownership without a per-call scan.

### Authorization

[`remote-access`](../../../../packages/api/remote-access/src/user-policy.ts) ships `createUserAccessPolicy`, and [`WorkspaceController`](../../../../packages/api/workspace-controller/src/index.ts) registers it as the `user` policy from its ownership index. A user holds a `global` role for the shared UI surface plus a Session role and a Workspace role on exactly the resources whose owning id resolves to their own key, so naming a different id reaches nothing; owner-only namespaces resolve to no user binding and stay refused.

### Security invariants

- Only in-process Host code supplies a principal, at Peer creation; no wire field, cookie, header, or argument overrides it.
- An authenticated browser is a `user`, never `owner`; `owner` is the process operator.
- One adapter owns one provider id, and a session record binds to that provider's triple.
- Per-user roots derive only from the canonical percent-encoded triple; a principal with an empty provider or subject is invalid, and a token that resolves no tenant is refused.
- A revoked or expired session record refuses admission, and logout deletes the record.
- A `user` reaches only resources whose owner resolves to their own key, through a binding that lists every allowed action.

### What this release does not do

Scoping happens at the registry and query layer: the session-persistence and storage backends still write where their bundle configuration points, so a deployment that serves several people must route those writes per user and run the migration the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.3/per-user-data-partition/guide.md) describes. Attachments, credentials, and settings stay process-scoped. Only the generic OIDC adapter ships; a provider-specific adapter for Lark, GitHub, or the DeepSeek Platform is a separate provider plugin that implements the same interface.

## Consequences

A person who signs in through a configured provider reads only their own Sessions and Workspaces, the operator keeps the complete global view, and the two identities no longer collapse into one Peer. The durable session record makes logout and expiry immediate and central, which the bare signed cookie could not do, and it keeps the login seam testable: an adapter is a value with three methods.

The cost is a runtime identity seam plus a scope resolution on every list and read: the caller is read from the invocation, and a scoped listing filters persisted snapshots by materialized location instead of a database predicate, so a `user` cannot read a live session and an unlocated record is invisible to that user. A deployment must enable a provider to get multi-user behavior; with none, the profile behaves exactly as before.

Residual risks stay with the deployment. Isolation holds only for durable roots the deployment has actually routed per user, the OIDC adapter trusts one issuer document and keeps its published keys for the plugin's lifetime, and a stolen cookie authorizes its session until the record expires or logout deletes it.

## Alternatives considered

**Per-user `DSH_HOME` subdirectories via static patch roots.** A `!!js` patch expression is evaluated once at boot, before any principal exists, so it cannot name the logged-in user; the partition happens at runtime instead, and `userHomePath` is the runtime root every consumer resolves.

**Repository-scoped `Scope` filters on lists only.** Scoping lists without partitioning durable state leaves the most sensitive records shared and hides presentation rather than isolating data; this release partitions the root and confines both the query layer and the workspace registry.

**A single hardcoded provider.** The seam keeps each provider a small optional plugin, so a deployment enables the adapters it needs; hardcoding one provider would have made every later source a change to the connection layer.

**A stateless JWT session.** A signed token with no central record cannot be revoked on logout; the durable `browser_sessions` record reuses the existing signed-cookie mechanism and gives revocation and expiry for free.

**Reuse the `share-viewer` principal for login.** `share-viewer` models a viewer granted a share by a token, not a person's owned data; reusing it would conflate sharing with identity and retrofit its per-share field into every login path.

**One server process per user.** A shared server serves many browser users on one bound port and home; process-per-user moves isolation to the OS and reintroduces per-process coordination the shared data plane avoids.

## Relation to existing Notes

This Note supersedes two implemented Notes in part, and both stay active and are cross-linked above. [Browser token authentication](../../implemented/architecture/2026-08-24-browser-token-authentication.md) is superseded only in what the cookie proves — a handle to a durable session record instead of ownerhood — and in the addition of logout; its authority binding, launch-token cleaning, persisted signing secret, and `Secure`-by-listener consequences remain its authority. [Peer principals and method-level Remote access control](../../implemented/architecture/2026-10-12-peer-principal-and-remote-access.md) is superseded only in `browserPeer` always carrying `{ kind: 'owner' }` and in treating the authenticated browser as the owner; the principal/peer split, default deny, resource resolution, list filtering, and source recording are unchanged and are the machinery this Note builds on. [Account provider and active request cancellation](../../implemented/architecture/2026-09-17-account-provider-signout.md) is related but not superseded: it owns DeepSeek account sign-out and in-flight cancellation for model routes, while this Note owns login identity and session revocation.
