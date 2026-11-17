# Agent Note: Hosted multi-user rollout and verification

Status: proposed

English | [中文](2026-11-18-hosted-multi-user-rollout.zh.md)

## Problem

The four preceding notes each change one layer of a single-process multi-user deployment. None of them is useful alone, and each is individually hard to verify as done: a boundary check that passes while persistence still writes globally produces a deployment where a person's session vanishes on creation, and a realm that partitions storage while authorization still admits any id produces a deployment where the partition is invisible to the person it serves.

The launch path compounds this. The two shipped multi-process launchers exist for exactly this problem and are excluded by the deployment decision: `dsh route-users` builds an entry whose `route-users` plugin claims the webserver fallback seat ([`packages/host/route-users/src/index.ts`](../../../../packages/host/route-users/src/index.ts)), while `client-connection` registers `/api` as a named prefix route ([`packages/client/connection/src/index.ts:165`](../../../../packages/client/connection/src/index.ts)). Route matching resolves exact, then longest prefix, then the fallback ([`packages/host/webserver/src/index.ts:651`](../../../../packages/host/webserver/src/index.ts)), so the entry answers `/api` itself and the proxy never sees a browser's API calls. The same proxy strips `upgrade` as a hop-by-hop header, so the WebSocket carrier a browser uses ([`packages/client/connection/src/client/index.ts:80`](../../../../packages/client/connection/src/client/index.ts)) never crosses it. Neither launcher is on this deployment's path, and this note records why so the next reader does not rediscover it.

What is missing is the composition that makes the four changes one working deployment, and the evidence that says it works.

## Proposal

One composition, one launcher, and a verification suite that fails when any layer regresses.

### The composition

The hosted profile is the shipped Web composition with four changes:

1. `identity-feishu` enabled with the deployment's app id, secret, and scopes. Every browser without a session is redirected to `/login` and admitted only after the Feishu exchange completes ([`packages/client/connection/src/rpc-host.ts:276`](../../../../packages/client/connection/src/rpc-host.ts), `authorizeIndex`).
2. The user-realm registry mounted, with the durable rows of [Per-user realm partitioning](2026-11-18-per-user-realm-partitioning.md) as its template.
3. `sandbox-policy` resolving the caller's boundary, with the principal clamp of [Per-user execution confinement](2026-11-18-per-user-execution-confinement.md).
4. The `user` access policy admitting the configuration endpoints of [Per-user credentials and settings](2026-11-18-per-user-credentials-and-settings.md), backed by owner records from [User resource authorization](2026-11-18-user-resource-authorization.md).

Nothing else in the composition changes: the launch path stays `dsh --profile web` with `--patch` overlays, because the deployment needs one process and one entry. The existing `multi-user-feishu.yml` overlay ([`apps/cli/config/examples/multi-user-feishu.yml`](../../../../apps/cli/config/examples/multi-user-feishu.yml)) is the login half of this and stays as-is; the note adds the partition half beside it.

The launchers stay in the tree for deployments that do choose process isolation. Recording their `/api` and WebSocket limits here is a statement about which model does not depend on them, not a plan to repair them.

### The first-run state

A fresh deployment has no `users/<key>` tree. The first authenticated request creates it, and creation must not race: two concurrent requests from one person must produce one realm, and two people must produce two roots. The registry's single-flight guarantee is what makes this safe, and the acceptance criteria test it with concurrent requests rather than sequentially.

A deployment upgrading from a single-user composition has sessions under `<home>/sessions`. They are not reachable from any realm. The migration is an explicit operator action, not a startup step: attribute what can be attributed, leave the rest, and document that unattributed sessions require the operator to open them.

### The verification suite

The evidence has to be behavioral, at the shipped endpoints, with two distinct authenticated users. Four existing test shapes cover it:

| Test | What it proves |
|---|---|
| Realm partition, unit | Two realms hold distinct service instances; `leakedServices` finds nothing |
| Boundary refusals, unit | Every path in [User workspace root boundaries](2026-11-18-user-workspace-root-boundaries.md) refuses; operator unaffected |
| Two-user isolation, host | A's session, workspace, attachment, and credential are unreachable from B through every Remote endpoint |
| Keyless recorded-session snapshot | The model-visible policy text states the clamped mode and the person's own root |

The third is the load-bearing one. It must run through the real Gateway with real Peers rather than a hand-built Context, because the guarantee under test is the routing between an authenticated request and a service instance, and a hand-built Context can wire that routing incorrectly and still pass.

The cross-user probe matrix is the tool table from [Per-user execution confinement](2026-11-18-per-user-execution-confinement.md): for each of `fs` read, `fs` write, `bash`, `terminal`, attachment resolution, and spill retrieval, one user is denied another's tree. A row with no probe is a gap.

### Rollout order

The layers are ordered by what breaks if they land alone.

1. **Boundaries first.** They only refuse, so a deployment that stops there is safer and loses nothing it had.
2. **Partition second.** Until it lands, a hosted deployment's listings are empty; this is the change that makes the deployment usable rather than a change that tightens it.
3. **Credentials and settings third.** They depend on the realm existing.
4. **Authorization last.** It depends on the owner field, which is a persistence change with its own review path.

Steps 1 and 2 together are the minimum viable deployment. A deployment that ships 1 and 2 and stops has correct isolation of durable state and correct workspace boundaries, with the current global credential document — workable for one trusted group and not for an open deployment.

## Alternatives considered

**Repair `route-users` instead of building the single-process path.** The repair is feasible: register the proxy on the `/api` prefix and on the `remote.mux` upgrade route instead of the fallback, and forward upgrades as a raw socket tunnel. It yields process-level isolation, which is stronger than a realm. Rejected because the deployment decision is one process and one port, and because the repair also has to prevent the entry's own `client-connection` from claiming `/api` first, which means splitting login from transport — a larger change than this proposal for a model the deployment does not want.

**Ship the layers as one change.** One branch, one review, one rollout — simpler coordination. It makes the failure modes indistinguishable: a realm bug and an authorization bug both present as "the user sees nothing", and bisecting a persistence change against a policy change in one diff is what the ordered rollout avoids. Rejected for that reason, with the cost that intermediate states are revisable.

**Rely on the recorded-session snapshot alone.** A snapshot pins model-visible text, which is the right evidence for the policy prompt. It replays recorded logs and cannot create two authenticated identities, so it cannot observe a cross-user refusal. It complements the two-user host test; it does not replace it.

## Acceptance criteria

- A fresh deployment admits two Feishu identities and produces two independent user roots.
- Concurrent first requests from one identity produce one realm, not two.
- Each of the four layers has a test that fails if the layer is removed, and each test runs at the shipped endpoint rather than through a helper.
- The two-user probe matrix denies every cross-user path and the matrix has one row per tool.
- A single-user deployment (no identity provider registered) behaves byte-identically, including the launch-token loopback.
- The upgrade from a single-user home is documented with its explicit migration, and no automatic startup migration runs.
- `pnpm run build:check` and `pnpm run doc-sync` pass with the new notes and their bilingual pairs.

## Risks

**Intermediate states are shippable but not safe.** A deployment that takes step 1 and stops has boundary checks and a global credential document; one that takes step 1 and skips step 4 has correct storage isolation and an authorization gap reachable by session id. The ordering note has to be read as a gate, not as a suggestion, and each step's acceptance criteria has to be the thing that gates the next.

**Single-user regression is the quiet failure.** Every layer here is conditional on a `user` principal, so the risk is a resolution that changes behavior when no principal is present. The byte-identical requirement in the criteria is what catches it, and it needs a test with the identity provider mounted but no adapter registered, which is the composition the seam treats as single-user.

**The verification suite is the slowest part and the easiest to weaken.** A two-user host test that runs both identities in one Context proves less than one that runs them through separate authenticated sessions, and the cheaper version is passing. Naming the requirement — real Gateway, real Peers, distinct credentials — is what keeps the evidence honest.

**Snapshots must move with the header change.** [User resource authorization](2026-11-18-user-resource-authorization.md) changes the persisted session header, and the repository requires the TypeScript and Python SDK expected outputs plus the recorded-session snapshots to move in the same change. A rollout that lands the header without them fails its own gates, which is the right outcome but has to be planned rather than discovered.
