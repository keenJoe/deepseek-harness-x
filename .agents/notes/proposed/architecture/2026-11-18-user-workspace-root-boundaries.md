# Agent Note: User workspace root boundaries

Status: proposed

English | [中文](2026-11-18-user-workspace-root-boundaries.zh.md)

## Problem

Hosted multi-user Web admits several people into one harness, but three entry points accept an absolute filesystem path from the browser or the model without any boundary check. Together they let one admitted person make the harness read and write anywhere the process can.

`session.create` resolves its directory as `workspace?.path ?? request.cwd ?? this.defaultCwd` ([`packages/api/session-controller/src/commands.ts:116`](../../../../packages/api/session-controller/src/commands.ts)). `request.cwd` arrives from the browser and is never compared against a root. The fallback `this.defaultCwd` is `process.cwd()` ([`packages/api/session-controller/src/index.ts:194`](../../../../packages/api/session-controller/src/index.ts)), so a deployment also inherits whatever directory the launcher happened to have.

`workspace.create` passes `request.path` straight to `workspaceRegistry.create` ([`packages/api/workspace-controller/src/commands.ts:52`](../../../../packages/api/workspace-controller/src/commands.ts)). That method canonicalizes the path and requires an existing directory ([`packages/workspace/workspace/src/index.ts:240`](../../../../packages/workspace/workspace/src/index.ts)), which rejects a typo but admits any directory the process can stat.

The model can move the boundary itself. SDK `setWorkingDirectory` forwards its path to `workingDirectory.set` ([`packages/sdk/server/src/server.ts:450`](../../../../packages/sdk/server/src/server.ts)), and `set` accepts a directory whenever `fs.stat` reports one ([`packages/session/working-directory/src/index.ts:204`](../../../../packages/session/working-directory/src/index.ts)). The session working directory then becomes the sandbox `workspace-write` root ([`packages/sandbox/sandbox-policy/src/index.ts`](../../../../packages/sandbox/sandbox-policy/src/index.ts), `resolve()`), so the move widens the writable root as well.

The Remote access policy does not close this: `USER_GLOBAL_ROLE` grants `session/create` and `workspace/create` to every admitted user ([`packages/api/remote-access/src/user-policy.ts`](../../../../packages/api/remote-access/src/user-policy.ts)), so the paths above are reachable by design.

The deployment decision for this work is that a person's workspace root is fixed at `<harness-home>/users/<userKey>/workspaces/` and is not selectable. Boundaries must therefore be derived from the authenticated principal, not proposed by the caller.

## Proposal

Introduce one resolved boundary per caller and enforce it at the operation that makes the decision.

**One resolver.** A new function in [`packages/identity/user-principal`](../../../../packages/identity/user-principal/src/index.ts) returns the workspace boundary for a principal:

```ts
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'

/** Absolute writable workspace boundary for one principal; the operator keeps the deployment root. */
export declare function workspaceBoundaryOf(principal: Principal): string
```

For a `user` principal it returns `userHomePath(String(userId(principal)), 'workspaces')` ([`packages/util/home-paths/src/index.ts:181`](../../../../packages/util/home-paths/src/index.ts)). For the operator and for in-process code it returns the configured deployment workspace root, preserving single-user behavior.

**`session.create`.** Replace the `?? this.defaultCwd` chain with a resolve step that runs before any directory is created: a named `workspaceId` must resolve to a workspace the caller owns, an explicit `cwd` must sit inside the caller's boundary, and the default becomes the boundary itself rather than `process.cwd()`. A request outside the boundary is refused with a stable code rather than clamped, because silently redirecting a named directory would run the session somewhere the caller did not ask for.

**`workspace.create`.** Canonicalize with the existing `realpathNormalize` and require the result to be inside the caller's boundary before registration. Canonicalizing first is what defeats a symlink planted inside the boundary that points outside it.

**`working_directory.set`.** Accept the boundary as an explicit argument and refuse a target outside it. The caller — the `working_directory` tool — resolves the boundary from `agent.session`, so the check sits in the operation that changes the directory, not in the tool.

**`sandbox-policy.resolve`.** The `workspace-write` root already follows `session.header.cwd`. Once the directory cannot leave the boundary, the sandbox root inherits that guarantee; the remaining gap is a session created before this change, whose recorded `cwd` may sit anywhere. `resolve()` therefore clamps a recorded `cwd` to the caller's boundary and falls back to the boundary when the recorded value is outside it.

`isWithinRoot` already exists in [`packages/identity/user-principal`](../../../../packages/identity/user-principal/src/index.ts) and compares at a path-separator boundary; every check above uses it rather than a string prefix test.

## Alternatives considered

**Allow a deployment-configured allow-list of extra roots.** It keeps "run a session against my existing checkout" working, but it reintroduces a caller-influenced path, needs its own admin surface, and contradicts the stated decision that the workspace root is fixed. Rejected for this deployment; the resolver leaves room to add a root set later without changing call sites.

**Clamp instead of refuse.** Turning `/etc` into the caller's boundary keeps a session working but hides that the caller asked for something they may not have. A named path is a stated intent, and the boundary check is the only place that intent can be answered honestly. Refused.

**Check in the web layer before the Remote call.** The browser is not the only caller: the SDK, the PTC runtime, and in-process code reach the same endpoints. A check above the Remote boundary would be bypassed by every non-browser caller, which the capability-seam rules name as non-enforcement.

## Acceptance criteria

- `session.create` with a `cwd` outside the caller's boundary returns `user/path-outside-root` and creates no directory.
- `session.create` naming a `workspaceId` owned by another user returns the same refusal.
- `workspace.create` with a path outside the boundary returns the refusal; a symlink inside the boundary pointing outside it is refused after canonicalization.
- The `working_directory` tool refuses `cd /`, `cd ..` past the boundary, and an absolute target outside it; the refusal reaches the model as an actionable message.
- A session whose recorded `cwd` is outside the boundary resolves its sandbox root to the boundary, not to the recorded directory.
- The operator principal and in-process callers keep the deployment root; an existing single-user deployment observes no behavior change.
- Tests cover each refusal through the Remote endpoint, not only through the helper.

## Risks

**Existing sessions.** A session created before this change records a `cwd` that may now be outside the boundary. The sandbox clamp keeps it from widening writes, but the session's own project directory stays where it is; an operator may need to recreate such sessions under `users/<userKey>/workspaces/`.

**Refusals surface late.** The boundary is resolved at `session.create`, so a user who is used to naming a repository path meets the refusal only when creating a session. The message has to name the allowed root, or the person cannot tell what to do.

**Operator root is still broad.** This note confines user principals only. A deployment that hands the operator cookie to a browser reopens every path here; the hosted login already refuses owner cookies once a provider is registered ([`packages/client/connection/src/rpc-host.ts`](../../../../packages/client/connection/src/rpc-host.ts), `admit()`), so the two decisions depend on each other.
