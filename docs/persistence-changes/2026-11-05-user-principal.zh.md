---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-05-user-principal

[English](2026-11-05-user-principal.md) | 中文

## 概述

向 `Principal` 联合类型新增 `user` principal 变体，在既有 `owner` 与 `share-viewer` 之外引入已登录用户（provider、tenant、subject、displayName、可选 avatarUrl）。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

同版本的增量变更。既有携带 `owner` 或 `share-viewer` principal 的持久化记录保持不变，双向读取仍然有效。读取方按字面 `kind` 切换并对未知 kind 走透传，因此旧读取方忽略 `user` principal，新读取方仍接受前两个变体。`principal` 缺失仍表示 owner；`user` 值只保存展示安全的身份三元组与显示名，不存任何凭据。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/identity/user-principal/tests/user-principal.spec.ts：7 个测试通过。pnpm run build:check：2 个通过。pnpm run verify-package-dependencies：95 个包匹配。

<a id="dev-note"></a>
## 开发备注

无。
