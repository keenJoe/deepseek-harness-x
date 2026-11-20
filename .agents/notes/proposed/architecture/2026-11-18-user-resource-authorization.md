# Agent Note: User resource authorization

Status: proposed

English | [中文](2026-11-18-user-resource-authorization.zh.md)

## Problem

[Per-user realm partitioning](2026-11-18-per-user-realm-partitioning.md) separates durable stores by person. It does not separate the registries keyed by resource id: `ctx.sessions` and `ctx.agents` hold every live session regardless of who started it, and a session id is the only handle a Remote call needs to reach one.

The policy that is supposed to close that gap filters lists, not entry points. `createUserAccessPolicy` computes bindings per call from the caller's owned session and workspace ids ([`packages/api/remote-access/src/user-policy.ts`](../../../../packages/api/remote-access/src/user-policy.ts)), and the controllers use it to filter what they return. The Gateway asks the policy for every call, and the policy denies a call whose named resource it does not bind. That part works.

What does not hold is the ownership fact the bindings are computed from. `UserAccessFacts.sessions(key)` and `.workspaces(key)` are supplied by the host, and the partition's own documentation states the current limit: `sessionQuery` scopes to the caller's persisted root, so a live session carries no ownership fact at all and is excluded from a scoped listing. A session that is live but was created by another user is therefore outside every listing filter and still reachable by id.

Two narrower gaps follow from the same place:

**Ownership is derived from location, not recorded.** A session's owner is inferred from which directory its log sits in. Anything that writes a log outside a user root, or reads one, changes the inferred owner. A recorded owner would be a fact; an inferred one is a consequence of the storage layout.

**Refusal codes conflate two failures.** `explainUserRefusal` reports `user/resource-not-owned` when the request named any non-global resource, and `user/no-access` otherwise. A caller cannot distinguish "that session belongs to someone else" from "that session does not exist", which is both a UX gap and an enumeration oracle: the two responses differ, so a user can probe for existing ids.

## Proposal

Record ownership where the resource is created, authorize at the endpoint, and make the refusal uniform.

### Record the owner

`SessionHeader` gains an optional owner field carrying the canonical user key. It is written once at session creation from the authenticated principal, and absent for the operator and in-process creation, which keeps every existing single-user log byte-identical.

The field belongs in the header rather than in a side table because ownership is immutable for the life of a session and must survive a directory move, a fork, and a copy. A fork inherits the source's owner. A subagent inherits its parent's owner, since the parent is the only party that started it.

This is a persistence-type change and needs both the acknowledgement the repository requires for declared persistence types and a version decision under the session-format rules: existing readers reject an unknown header key ([`packages/session/session-persistence-jsonl/src/format.ts:163`](../../../../packages/session/session-persistence-jsonl/src/format.ts) requires every key to be in `HEADER_KEYS`), so the field's addition is reader-visible and must be versioned with its own reader behavior rather than slipped into the current version.

### Authorize every endpoint, not only the listing

Each Session and Workspace Remote endpoint resolves its resources through the policy, and the policy binds a `user` principal to exactly the ids whose recorded owner equals the caller's key. That binding already exists; what changes is the fact behind it, from "the log is under my directory" to "the header records me".

Endpoints that create a resource take no resource argument, so they are admitted by the global role. Endpoints that name one are denied unless the policy binds it. The existing `USER_SESSION_ROLE` and `USER_WORKSPACE_ROLE` action lists are the admitted set; a new endpoint must be classified rather than defaulting to admitted.

### One refusal for every miss

A user request for a resource the policy does not bind returns the same code and the same message whether the resource belongs to another person or does not exist. Enumeration resistance is the reason, and it costs nothing the legitimate caller needs: a session in their own list is always a session they can open.

The distinct `user/no-access` code survives for an endpoint no role lists, because that is a composition fault an operator debugs rather than a user-visible condition.

### A gate for the classification

The classification is the part that rots: a new Remote endpoint is added, nobody classifies it, and it silently defaults to admitted by the global role it happens to match. A repository gate reads the Typert endpoint table and requires each endpoint to appear in one of three places — a user role's action list, an explicit owner-only declaration, or an explicit user-denied declaration. An unclassified endpoint fails the gate.

This follows the repository's rule that a mechanically checkable invariant belongs in an executed gate, and it is the only way the guarantee survives the next endpoint.

## Alternatives considered

**Keep deriving ownership from the persisted path.** It needs no format change and no migration. It also cannot see a live session, which is exactly the reachable set, and it makes ownership a function of where a log was written rather than of who created it. Rejected as structurally unable to answer the question.

**Move live sessions into per-user registries.** A realm would own its `sessions` and `agents` registries, and an id from another realm would simply not resolve. This is the strongest shape and would remove the policy from the session path entirely. It is rejected for this change because the Agent loop, the subagent factory, and the Gateway's live-control streams resolve sessions from one store, and splitting it is a larger change than the partition it would serve. It remains the right long-term shape if the policy surface keeps growing.

**Deny by default and grant explicitly per endpoint.** This is what the classification gate approaches, but applied at runtime it would break every in-process caller that has no principal. The gate gets the same protection at build time with no runtime change for callers the policy does not see.

## Acceptance criteria

- A session created by user A records A's canonical key in its header; a session created by the operator records no owner.
- A fork of A's session is owned by A; a subagent of A's session is owned by A.
- User B calling any Session endpoint with A's session id is refused with the not-found-shaped response.
- User B calling with an id that does not exist gets a byte-identical refusal.
- Every listed Session and Workspace endpoint is classified in the gate; adding an unclassified endpoint fails it.
- Existing logs without the owner field remain readable and resolve as operator-owned or unowned per the documented rule, and the reader behavior for the new version is tested in both directions.
- Both SDK expected outputs and the recorded-session snapshots reflect the header change.

## Risks

**A persistence change to the session header is the riskiest part.** It touches the format status document, the reader compatibility review, the persistence catalog, and both SDK projections. The field is optional and immutable, which is the cheapest shape available, but a version bump makes old and new generations coexist on disk and the migration story has to be stated before the change lands.

**Unowned sessions remain reachable by the operator only.** Existing sessions carry no owner. Resolving them as operator-owned is the conservative choice — nobody gains reach they did not have — but a person who created a session before this change cannot open it afterwards. A migration that stamps owners from directory location would reintroduce the inference this proposal removes, so it must be an explicit operator action.

**The gate needs a source of truth that is itself generated.** The Typert endpoint table is generated; the classification list is authored. A generator change that renames an endpoint would fail the gate for a reason unrelated to authorization, and the failure message must say so.

**Uniform refusal hides a real diagnosis.** An operator debugging a user report cannot tell an ownership miss from a missing session without server logs. The refusal carries the distinction in the log, not the wire.
