---
kind: upgrade-guide
description: "Session listings, exact reads, and workspace operations are confined to the calling user, and a new opt-in migration moves legacy owner data under users/<userKey>."
---

# Per-user data partition

English | [中文](guide.zh.md)

## Change

The hosted multi-user profile partitions each logged-in person's durable data under `<DSH_HOME>/users/<userKey>`, where `userKey` is the canonical percent-encoded identity triple from the identity packages. A Remote call that carries a `user` principal now reads and mutates only that user's items. `sessionQuery.listSessions`, `filterSessions`, and the exact session reads are confined to persisted sessions whose materialized location is under the caller's `users/<userKey>` root, and they drop live sessions. `workspaceRegistry.list` and its mutations — `get`, `resolveByPath`, `delete`, `insertBefore`, `create`, `createCanonical`, archive, pin, and their getters — are confined to workspaces stamped with that user's key, and `create`/`createCanonical` stamp `owner` on new records. The owner principal and trusted in-process code are unchanged and keep the complete global corpus and registry. Hosts that deploy multiple logged-in users, or SDK/wire clients that list or mutate sessions or workspaces, are affected.

## Migration

1. Stop the harness, then run the opt-in migration once for each user: resolve the harness home with `resolveDshHome()`, the user root with `userHomePath(userKey)`, and call `migrateLegacyRootToUser(resolveDshHome(), userRoot)`. It renames every direct child of the legacy home into the per-user root and refuses before changing anything when any destination child exists or a directory is missing, so the legacy home stays intact on failure. Do not run it on every startup.
2. Confirm each durable root moved: `sessions`, `storages`, `attachments`, and settings files should now sit under `users/<userKey>`, with the legacy home left empty but in place.
3. Partition and route per-user writes in the session-persistence and storage backends, since the registry-level scoping in this release reads the per-user location but does not reroute backend writes.
4. Rebuild hosts and clients and confirm a `user` sees only its own sessions and workspaces while the owner still sees all records.
