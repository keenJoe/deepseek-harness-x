---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-05-user-principal

English | [中文](2026-11-05-user-principal.zh.md)

## Summary

Adds the `user` principal variant to the `Principal` union, introducing a logged-in user (provider, tenant, subject, displayName, optional avatarUrl) alongside the existing `owner` and `share-viewer` principals.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-05-user-principal
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "28e9e38addab30dab4b5ecdcc2e24b5c45129b4f8ed1a4434b53a61b6f200c0d"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "39f49e817e073e65b29f8761446e58271ea26a6874895b1f0cc709189759f649"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "5026c370f50fb86715f0b659335420b956a4f582515b828578baca2bd8eaae19"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "97892829ae0f6f2a30506fab53c5ac4f80dbdc2668c960737ba70b45c7e34c38"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Additive same-version change. Existing persisted records that carry `owner` or `share-viewer` principals are unchanged and remain valid in both directions. Readers switch on the literal `kind` and fall through unknown kinds, so an older reader ignores a `user` principal and a newer reader still accepts the two prior variants. An absent `principal` keeps meaning the owner, and the `user` value stores no credentials, only a presentation-safe identity triple and display name.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/identity/user-principal/tests/user-principal.spec.ts: 7 tests passed. pnpm run build:check: 2 passed. pnpm run verify-package-dependencies: 95 packages matched.

<a id="dev-note"></a>
## Dev Note

None.
