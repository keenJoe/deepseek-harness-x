---
description: "DeepSeek Harness 中用于按用户隔离的已登录用户 principal 与规范用户 id。"
kind: "package-library"
---

# @deepseek-ai/dsh-user-principal

[English](README.md) | 中文

## 概述

`dsh-user-principal` 为托管的多人连接层提供一个调用方身份值：以与 provider 无关的身份三元组命名一个已登录用户的 `user` principal、为每个按用户隔离的会话、工作区、凭据与附件划定范围的、带品牌的 `UserId` 分区键，以及每个按用户存储都据此解析的持久化根目录辅助函数。部署的身份 adapter 在登录时解析三元组；本包将其规范化，只复制三元组、显示名与可选头像，因此任何凭据都不会进入会话日志。它不注册任何内容，也不持有存储。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

凡是登录后为 Peer 铸造其 `Principal` 的代码，或是需要命名或比较两个已登录用户的代码，都导入本包：把身份 adapter 的 actor 转换为 Peer 的托管连接层，以及把每个 `user` 限制在各自资源内的 remote-access 策略。应使用 `userId` 而不是手工拼接三元组，因为它应用了带百分号编码与空 tenant 规则的规范键编解码。

### 入口

```ts
import { callerOf, callerRoot, isWithinRoot, isUser, operatorRoot, userOf, userId, userPrincipal, userRoot } from '@deepseek-ai/dsh-user-principal'
```

`userPrincipal` 规范化 `IdentityActor` 并返回 `user` principal，或在 provider 或 subject id 为空时返回 `undefined`；`userOf` 把任意 `Principal` 收窄到该 kind；`isUser` 按完整身份键比较；`userId` 渲染每个按用户路径都据此划分的、带品牌的规范键。`UserPrincipal` 与 `UserId` 类型描述该值及其分区键。

`callerOf` 读取当前 Remote 调用的已登录调用方，对操作者与受信任的进程内代码返回 `undefined`；`callerRoot` 返回该调用方拥有的持久化根目录（追加存储方给出的路径段），对这些调用方回退到操作者 home；`userRoot` 与 `operatorRoot` 显式指定两者之一；`isWithinRoot` 在路径分隔符边界上判断绝对路径是否属于某个根，因此 `users/alice-2` 不会匹配 `users/alice`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`index.ts` 用 `user` kind 扩充来自 `@deepseek-ai/dsh-typert-protocol` 的可合并扩展 `PrincipalMap`，然后通过规范化 tenant 并逐字段复制，从 `IdentityActor` 构造该值。`UserId` 品牌包装来自 `@deepseek-ai/dsh-identity-protocol` 的 `identityKeyOf` 输出，因此分区键与 owner bundle 与 Relay 已共用的 ACL 键保持一致。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 扩充 `PrincipalMap` 并导出构造器、收窄器与 `UserId` 品牌的根入口 |

### 为何是普通模块

`user` principal 是带唯一字面量 `kind` 且无凭据的 JSON 值，因此可安全持久化到会话日志，且构造时无需 Cordis 注册、socket 或存储。保持普通库形态让连接层与 remote-access 策略无需挂载插件即可导入同一值。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你需要本值所包装的身份契约，或铸造它的消费方时，阅读以下页面。

- [Identity protocol](../identity-protocol/README.zh.md) —— 本包所包装的、与 provider 无关的三元组与规范键编解码。
- [identity 包组](../README.zh.md) —— 列出本包的包组。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- `userPrincipal` 接受任意 `IdentityActor`，不做任何认证；解析该 actor 的身份 adapter 拥有这条边界，且不应从未认证的 actor 铸造任何 Peer。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
