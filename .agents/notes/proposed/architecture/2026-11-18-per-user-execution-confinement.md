# Agent Note: Per-user execution confinement

Status: proposed

English | [中文](2026-11-18-per-user-execution-confinement.zh.md)

## Problem

A model runs tools on behalf of the person who started the session. In a process serving several people, nothing in the execution path currently knows which person that is, so a tool's file effects are governed only by the session's recorded `cwd` and by the deployment's sandbox defaults.

Three layers decide what a tool may touch, and each has a gap.

**The sandbox policy root** is `session.header.cwd ?? this.workspaceRoot` ([`packages/sandbox/sandbox-policy/src/index.ts`](../../../../packages/sandbox/sandbox-policy/src/index.ts), `resolve()`). The fallback is a deployment constant read once at construction. A session that records no `cwd` therefore runs under the deployment root, and a session whose `cwd` was set before [User workspace root boundaries](2026-11-18-user-workspace-root-boundaries.md) could point anywhere.

**The permission mode** is per session, last write wins, from the logged `sandbox/mode` event. Its value set includes `danger-full-access`, which bypasses confinement entirely. Nothing constrains that value by principal, so a user who can reach the permission surface can grant their own session unrestricted file access.

**The durable stores** a tool writes through — `attachment-local` and `spill-local` — are process singletons today. Their files are content-addressed or session-hash-named under one root, so two people's tool output shares a directory tree.

The `fs` service and the shell and terminal tools resolve their roots from the sandbox policy and the session working directory, so fixing those two fixes the tools that consume them. The gap is not in each tool; it is that no layer knows the caller.

## Proposal

Make the caller part of every policy resolution, and clamp the mode by principal.

### The policy carries the boundary

`SandboxPolicyService.resolve(request)` gains the resolved boundary instead of deriving a root from `session.header.cwd` alone. The input stays `{ session?, mode? }`, and the service reads the caller from the ambient invocation — the same `callerOf(ctx)` path [Per-user realm partitioning](2026-11-18-per-user-realm-partitioning.md) routes through, so the boundary and the realm agree by construction.

Resolution order becomes:

1. An approved explicit mode, unchanged.
2. The session's last logged mode, **clamped by the caller's ceiling**.
3. The caller's boundary as `workspaceRoot`.

Because each realm mounts its own `sandbox-policy` with `workspaceRoot: userHomePath(key, 'workspaces')`, a session in that realm that records no `cwd` already resolves the person's own root. The clamp is what the realm cannot supply.

### Clamp the mode by principal

A `user` principal may reach at most `workspace-write`. `danger-full-access` stays available to the operator and to in-process code, which is where the existing escalation surfaces that request it already live — `plugin-manager` names it explicitly ([`packages/boot/plugin-manager/src/tools.ts:107`](../../../../packages/boot/plugin-manager/src/tools.ts)) and `tool-cordis` lets a caller request it.

The clamp is a downgrade, not a refusal: a user session whose last logged mode is `danger-full-access` resolves `workspace-write`. Refusing would fail a replaced mode with an error the model cannot act on, while downgrading keeps the turn running inside the boundary the deployment promises. The downgrade must be visible — the resolved policy is what the model reads as its file-policy context, so the prompt states the effective mode rather than the requested one.

The clamp belongs in `resolve()`, which is the one operation every consumer calls before executing. Enforcing it at the permission surface instead would leave the PTC runtime, which writes its own `sandbox/mode` events ([`packages/core/tool-executor-ptc/src/ptc-calls.ts:23`](../../../../packages/core/tool-executor-ptc/src/ptc-calls.ts)), outside the check.

### Extra writable roots follow the same rule

`additionalWritableRoots` is deployment config and stays fixed. A user realm must not inherit a root outside the person's boundary, so the realm's template either omits the field or sets it under `users/<key>`. A deployment that needs a shared read-only corpus belongs in the filesystem service's read policy, not in the writable roots of an unconfined tool.

### The durable stores move into the realm

`attachment-local` and `spill-local` are realm rows per [Per-user realm partitioning](2026-11-18-per-user-realm-partitioning.md), so their files land under `users/<key>`. This is where content addressing becomes safe: a reference is a hash, and a hash is only a read capability if the store that resolves it is reachable. Two realms never share a store, so a leaked reference from one person's session resolves nothing in another's.

### Verify the tool surface

The tools that reach the filesystem must each be confirmed to resolve their roots from the realm:

| Tool | What it resolves | Where the check belongs |
|---|---|---|
| `tool-fs`, `tool-fs-search`, `tool-str-replace-editor` | `ctx.fs` with the session cwd | `fs` backend + session cwd |
| `tool-bash`, `tool-pwsh` | sandbox policy argv wrapper | `resolve()` clamp |
| `tool-terminal` | sandbox policy per session | `resolve()` clamp |
| `working_directory` | `workingDirectory.set` | boundary check from [User workspace root boundaries](2026-11-18-user-workspace-root-boundaries.md) |
| `tool-fs` read of an attachment | `attachment-local` store | realm store |

Any tool that resolves one of these through the root realm is a leak. `leakedServices` catches a service published into the root realm from a realm mount, but it cannot catch a root-realm consumer that should have been realm-scoped, so this table is a review obligation rather than a mechanical gate — which is why the acceptance criteria name a cross-user probe per row.

## Alternatives considered

**Confine by process-level sandbox alone and drop the in-process checks.** The existing sandbox backends already confine a subprocess to one root. They cover shell and terminal calls and nothing else: `fs`, attachment reads, and the model's own file tools never leave the process. Rejected as covering a fraction of the surface.

**Refuse instead of downgrade on `danger-full-access`.** A refusal is honest about intent, but the mode is replaced by tools the user did not write — `auto-review` sets a permission preset ([`packages/experimental/auto-review/src/index.ts:794`](../../../../packages/experimental/auto-review/src/index.ts)) — so the refusal would fail turns the person cannot diagnose. The downgrade keeps the boundary; the visibility requirement is what carries the honesty.

**Give each person their own OS user and rely on file permissions.** This is the strongest boundary and is what makes the multi-process launchers equivalent to isolation. It requires a deployment-owned account per person, which the one-process decision excludes.

## Acceptance criteria

- A user session whose last logged mode is `danger-full-access` resolves `workspace-write`, and the model-visible policy text states `workspace-write`.
- The operator resolves `danger-full-access` exactly as before.
- A user session with no recorded `cwd` resolves its writable root to `users/<key>/workspaces`.
- User A's model cannot read a file under `users/<keyB>` through any of: `fs` read, `bash` `cat`, `terminal`, or an attachment reference.
- User A's model cannot write into `users/<keyB>` by any of those paths.
- Each row of the tool table is covered by a probe that runs as one user and asserts refusal against another user's tree.
- A realm reports no service leaked into the root realm.

## Risks

**Downgrade is silent to an API caller.** The resolved policy is visible to the model, but a client that asked for `danger-full-access` and reads back a tool failure for a permission reason has to infer the clamp. The denial message a confined tool returns already carries escalation guidance; that guidance now leads to a request the deployment will clamp again, so the message must name the ceiling rather than offer the escalation.

**Windows ACL materialization.** `sandbox-local`'s Windows backend materializes a per-session ACL grant keyed on the workspace root ([`packages/sandbox/sandbox-local/src/index.ts:406`](../../../../packages/sandbox/sandbox-local/src/index.ts)). Per-user roots multiply those grants, and the standing per-workspace grant assumption in that backend was written for a deployment with one root.

**Boundary and realm can disagree.** Two independent resolutions — the realm's `workspaceRoot` config and the boundary the policy computes — can drift. They must read the same helper, and a test must assert the equality rather than the deployment trusting two literals to match.

**Read paths stay broader than write paths.** `fs` reads are governed by the sandbox policy's mode, and a `read-only` mode permits reads of required sinks. A design that restricted reads to the person's root would break every tool that reads a system header or a package file. This proposal confines writes and process effects; it does not attempt to make one person's filesystem invisible to another's tool reads, and that limit has to be stated rather than assumed.
