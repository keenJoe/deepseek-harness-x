---
description: "owner bundle 与 Relay 共用的、与 provider 无关的 OAuth 身份契约与规范 ACL 键编解码。"
kind: "package-library"
---

# @deepseek-ai/dsh-identity-protocol

[English](README.md) | 中文

## 概述

`dsh-identity-protocol` 让 Liveshare owner bundle 与 Relay 共用同一份与 provider 无关的 OAuth 身份契约：命名一个人的 `IdentityTriple`、部署身份 adapter 所实现的浏览器授权与兑换接口，以及每个 adapter 在身份入库前都要应用的规范 `providerId:tenantId:subjectId` ACL 键编解码。它不持有凭据存储、HTTP 客户端或运行时状态，因此两个消费方共享同一份无依赖副本。根入口导出类型与键 helper；回环 `MockIdentityProvider` 仅通过 `./src/*` 供测试与本地运行使用。

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

凡是需要命名一个身份或比较两个身份的代码，都导入本包：存储分享 ACL 的 owner host、在准入前解析 viewer 的 Relay，以及把 provider 回调转换为 actor 的身份 adapter。应使用键编解码，而不是手工拼 `providerId + tenantId + subjectId`，因为编解码还会处理百分号编码与空 tenant 规则。

### 入口

```ts
import { identityFromKey, identityKeyOf, normalizeIdentity } from '@deepseek-ai/dsh-identity-protocol'
```

`identityKeyOf` 把规范化后的 actor 渲染为所有 ACL 比较使用的稳定键；`identityFromKey` 把该键解析回来，并对非规范输入返回 `undefined`；`normalizeIdentity` 为不签发 tenant 的 provider 填入文档化的 `default`。类型（`IdentityTriple`、`IdentityActor`、`IdentityProvider` 及授权与兑换请求）描述 adapter 实现的浏览器 OAuth 契约。回环 `MockIdentityProvider` 仅供测试与本地运行：从 `@deepseek-ai/dsh-identity-protocol/src/mock` 导入，不要让它进入发布调用路径。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`types.ts` 声明身份三元组、解析后的 actor、浏览器授权与兑换请求，以及 `IdentityProvider` 接口。`keys.ts` 拥有规范键编解码与每个 adapter 在身份入库前应用的 tenant 规范化。`mock.ts` 基于固定 persona 列表实现 `IdentityProvider`，用于确定性测试；根入口只复出 `types` 与 `keys`，绝不导出 mock。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 复出身份类型与键编解码的根入口 |
| [`src/types.ts`](src/types.ts) | 与 provider 无关的身份三元组、actor 与 `IdentityProvider` 契约 |
| [`src/keys.ts`](src/keys.ts) | 规范 ACL 键编解码与 tenant 规范化 |
| [`src/mock.ts`](src/mock.ts) | 供测试与本地运行使用的回环身份 provider；仅经 `./src/*` 引入 |

### 为何保持无依赖

身份契约不需要 Cordis 服务、socket 或存储：三元组是普通值，键编解码是对字符串的纯函数，mock provider 只构造 `URL` 与 `Promise` 值。保持无依赖意味着 owner bundle 与 Relay 可以各自安装可互换的副本，而无需导入不相关的能力。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你需要存储或解析这些身份的消费方时，阅读以下页面。

- [Liveshare protocol](../../experimental/liveshare-protocol/README.zh.md)——从其根入口为 owner bundle 与 Relay 复出本契约。
- [identity 包组](../README.zh.md)——列出本包的包组。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- `MockIdentityProvider` 把固定 persona 列表解析为 actor，不执行任何真实认证；它仅用于测试与本地运行，部署必须针对真实 OAuth provider 实现 `IdentityProvider`，任何身份才能进入生产准入路径。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
