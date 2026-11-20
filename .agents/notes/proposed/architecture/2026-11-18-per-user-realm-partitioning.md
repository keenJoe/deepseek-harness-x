# Agent Note: Per-user realm partitioning of durable state

Status: proposed

English | [中文](2026-11-18-per-user-realm-partitioning.zh.md)

## Problem

A hosted multi-user Web deployment that runs one process for several people shares one set of durable-service singletons. Every one of them resolves its root from the harness home at construction:

| Service | Root | Source |
|---|---|---|
| `session-persistence-jsonl` | `<home>/sessions` | [`packages/bundle/base/cordis.patch.yml:141`](../../../../packages/bundle/base/cordis.patch.yml) |
| `storage-json` | `<home>/storages` | [`packages/bundle/base/cordis.patch.yml:185`](../../../../packages/bundle/base/cordis.patch.yml) |
| `attachment-local` | `<home>/attachments/v1` | [`packages/attachment/attachment-local/src/index.ts:180`](../../../../packages/attachment/attachment-local/src/index.ts) |
| `spill-local` | OS temp private root | [`packages/spill/spill-local/src/index.ts:88`](../../../../packages/spill/spill-local/src/index.ts) |
| `credentials-local` | `<home>/.credentials.yaml` | [`packages/credentials/credentials-local/src/index.ts:90`](../../../../packages/credentials/credentials-local/src/index.ts) |

The read side already assumes a per-user partition. `sessionQuery.listSessions`, `filterSessions`, and the exact reads confine themselves to `users/<userKey>/**` for a `user` principal ([`packages/session-query/session-query/src/index.ts:406`](../../../../packages/session-query/session-query/src/index.ts)), and `workspaceRegistry` filters records by a stamped `owner` ([`packages/workspace/workspace/src/index.ts:1010`](../../../../packages/workspace/workspace/src/index.ts)).

The write side never followed. `session-persistence-jsonl` resolves its configured root once ([`packages/session/session-persistence-jsonl/src/index.ts:326`](../../../../packages/session/session-persistence-jsonl/src/index.ts)) and materializes every session under it, so a user's session lands in `<home>/sessions` while their listing reads `users/<userKey>/sessions`. In one process serving several people the listing is therefore permanently empty, and two people's sessions share one directory tree.

The previous release acknowledged this: its [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.3/per-user-data-partition/guide.md) states that registry-level scoping "reads the per-user location but does not reroute backend writes", and lists partitioning the backends as a separate step.

The deployment decision for this work is one process, one Feishu application, several people, each with their own durable state and their own credentials. Multi-process supervision (the `serve-users` and `route-users` launchers) is therefore out of scope: it obtains isolation from the process boundary, which this deployment does not have.

## Proposal

Partition by mounting one isolated service realm per logged-in person, and route each authenticated call into its realm.

### Why a realm rather than a per-call root

Every backend above takes its root as validated config and resolves it once. Teaching each one to resolve a root per call would mean changing `create`, `open`, `list`, `stat`, and every future method in five packages, and would leave `list()` semantically ambiguous — whether it lists the caller's sessions or the whole store. A realm changes none of them: the service instance a call reaches already has the right root.

Cordis already supports this. `Context.isolate(name, label)` gives one service name a distinct implementation per isolation label ([`vendor/cordis/src/context.ts:121`](../../../../vendor/cordis/src/context.ts)), and the preset mount logic treats a service published into the root realm from an isolated subtree as a leak and refuses the mount ([`packages/preset/agent-preset-registry/src/mount.ts:213`](../../../../packages/preset/agent-preset-registry/src/mount.ts)). That audit is what makes a realm's boundary checkable rather than a convention.

### The registry

A new service owns the realms:

```ts
import { Service, type Context } from '@deepseek-ai/cordis'
import type { UserPrincipal } from '@deepseek-ai/dsh-user-principal'

/** One isolated durable-service realm per logged-in person. */
export abstract class UserRealmRegistry extends Service {
  /**
   * @param user - the authenticated principal.
   * @returns the realm serving this person, created on first use.
   */
  abstract obtain(user: UserPrincipal): Promise<Context>
}
```

`obtain` keys on `String(userId(user))`, the same canonical `provider:tenant:subject` key the rest of the partitioned code uses. Creation mounts a fixed row template into a fresh `isolate` scope:

- `session-persistence-jsonl` → `root: userHomePath(key, 'sessions')`
- `storage-json` → `root: userHomePath(key, 'storages')`
- `attachment-local` → `dshHome: userHomePath(key)`
- `spill-local` → `root: userHomePath(key, 'spill')`
- `credentials-local` → `path: userHomePath(key, '.credentials.yaml')`
- `settings` and `config-editor` → scoped to `userHomePath(key)`
- `sandbox-policy` → `workspaceRoot: userHomePath(key, 'workspaces')`

The template is data, not a second composition: one array of rows the registry mounts, so adding a durable backend is one entry rather than a change to isolation logic.

Creation is idempotent and single-flight per key. A concurrent first request must not mount two realms, so `obtain` keeps a promise per key and returns that promise, following the same rule the codebase applies to one asynchronous operation with one lifecycle owner.

### Routing a call into its realm

The Gateway already builds a per-call Context: [`packages/api/gateway/src/index.ts:858`](../../../../packages/api/gateway/src/index.ts) binds `this.ctx.invocation` so a service reads the call as its own. Routing is one more step on that Context — isolate the private service names and bind them to the caller's realm — after which every downstream `ctx.get('sessionPersistence')`, `ctx.get('credentials')`, or `ctx.get('sandboxPolicy')` resolves the caller's instance without a single call-site change.

A call with no `user` principal — the operator, in-process code, tests — keeps the root realm, so a single-user deployment observes the same composition it has today.

### What the realm does not separate

`ctx.sessions` and `ctx.agents` are registries keyed by `SessionId`, not by person, and live sessions are in-memory. A realm does not hide them. Authorization for those stays with the Remote access policy, which is [User resource authorization](2026-11-18-user-resource-authorization.md)'s subject.

## Alternatives considered

**Recover partition isolation by running one process per person.** The shipped `serve-users` and `route-users` launchers do exactly this, and process boundaries are stronger than service realms. Rejected because the deployment decision is one process: it also keeps one login entry and one shared port, which the two-process model cannot provide without an identity-routing proxy whose `/api` and WebSocket forwarding is unimplemented ([`packages/host/route-users/src/index.ts`](../../../../packages/host/route-users/src/index.ts) claims the fallback seat, which a named `/api` prefix route never reaches).

**Keep the global store and filter every read and write by owner.** Sessions would need an owner field in the header, and every backend would need a filter it does not have — including `list()`, `stat()`, and crash repair, which recover logs by scanning directories rather than by reading a header. It also leaves one corrupt or mis-scoped write able to cross the boundary. Rejected as more surface with a weaker guarantee.

**Partition only the session store and leave attachments and spill global.** The two are content-addressed: attachment refs are hashes, so a user who learns another's ref can read their bytes. Leaving them shared contradicts the requirement that one person's work does not reach another's.

## Acceptance criteria

- Two admitted users create a session each; their logs materialize under `users/<keyA>/sessions` and `users/<keyB>/sessions` and neither listing shows the other's.
- Each user's `storage`, `attachments`, and `spill` files land under their own root.
- A realm is created once per key under concurrent first requests; a disposal leaves no registered service behind.
- `leakedServices` reports nothing for a mounted realm, proving the private rows stayed inside the isolate boundary.
- A call with no `user` principal resolves the root realm and behaves exactly as before.
- The registry disposes every realm when its own fiber unloads, and a disposed realm refuses further calls rather than serving from a torn-down context.

## Risks

**Realm lifetime is new shared state.** A registry of contexts is exactly the kind of global state the package rules warn about. It must be owned by a service, keyed by the canonical user id, and disposed with its fiber; a `WeakMap` keyed by principal or a module-level map would hide the owner.

**Memory grows with admitted users.** Each realm holds its own backends, caches, and file watchers. An idle-user disposal policy is a real need but needs its own decision — an eviction that races an active turn would strand a session's writes.

**Migration of existing data.** Sessions already written under the global `<home>/sessions` are not reachable from any realm. `migrateLegacyRootToUser` moves one legacy root into one user root, but it refuses when a destination child exists and cannot partition a shared tree by owner. A deployment that already served several people from one home has sessions it cannot attribute.

**Watchers multiply.** `credentials-local` watches its document and `storage-json` opens handles per domain. Each realm adds its own; the operating-system inotify or kqueue budget becomes a deployment limit that the current single-realm code never met.
