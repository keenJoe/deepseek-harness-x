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
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "3feadef4a852c592588bc26d5d9042e4f84c788fac8b069613ce209c74485f6d"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "ea15217f4fa96fac3f631b5bd5195e95f2228ec95e38768c7ec38388ef8d561d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "90a5ec363ae60e3384b66524e552120ecf408c7ad665ec7892bc0deac1a6c096"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "1841ab8689d5c09bd552835bcabee7e72cab37f0f0f1dba605d7c56322d27acb"
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
