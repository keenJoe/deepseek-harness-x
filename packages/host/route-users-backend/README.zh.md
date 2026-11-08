---
description: "校验入口签名的调用方头，使每用户后端放行已由入口认证的请求。"
kind: "package-library"
---

# @deepseek-ai/dsh-route-users-backend

[English](README.md) | 中文

## 概述

`dsh-route-users-backend` 是可信转发 seam 的后端一半。它提供 `ctx.connectionTrust`，校验入口签名的调用方头，使每用户后端放行入口已认证的请求，同时绝不持有登录 Cookie 密钥。没有有效且新鲜转发证明的请求会被 Connection 本身拒绝。

## 目录

- [使用本包](#use-this-package)
- [配置](#config)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [模型体验](#model-experience)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在每个每用户后端上挂载它，使用与入口路由相同的 `forwardSecret`：

```yaml
- id: route-users-backend
  name: '@deepseek-ai/dsh-route-users-backend'
  config:
    forwardSecret: !!js process.env.DSH_FORWARD_SECRET

```

后端仍需挂载 `client-connection`；本插件只提供 connection 层优先查询的信任上下文。

<a id="config"></a>
## 配置

| Key | 默认值 | 含义 |
|---|---|---|
| `forwardSecret` | 必填 | 共享转发密钥，等于入口路由的 `forwardSecret`。 |

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 转发证明五秒后过期；入口每次请求重新签名，因此这只限制重放，不限制合法流量。
- 密钥由入口与所有后端共享；轮换需重启整个集群。

<a id="model-experience"></a>
## 模型体验

无。信任发生在 HTTP 表面，不会进入模型请求。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
