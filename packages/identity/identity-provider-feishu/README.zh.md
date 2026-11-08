---
description: "添加一个由部署配置的飞书开放平台身份提供方，把托管 Web 登录解析为一名已登录用户。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-identity-provider-feishu

[English](README.md) | 中文

## 概述

`dsh-identity-provider-feishu` 在 `ctx.identityProviders` seam 上注册一个飞书开放平台身份提供方，让托管 Web profile 在飞书完成登录，并在解析出已登录用户后才接入会话。该行出厂即禁用：app id 与 app secret 属于部署事实，因此由 profile patch 填入配置后启用。飞书不返回 `id_token`，所以适配器用授权码换取 `user_access_token`，再从用户信息端点读取用户；解析出的身份以飞书 `open_id` 与租户 key 为键。

## 目录

- [使用本包](#use-this-package)
- [配置](#config)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [模型体验](#model-experience)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已挂载 Web server 与 identity-provider 注册表的 profile 中启用 `identity-provider-feishu` 行：

```yaml
- id: identity-provider-feishu
  disabled: false
  config:
    id: feishu
    appId: cli_xxxxxxxx
    appSecret: your-app-secret
```

配置 `id` 是注册表 id：它用于在 `?provider=` 中选择该提供方、作为注册表键，并成为每个解析身份携带的 `providerId`。

<a id="config"></a>
## 配置

| Key | 默认值 | 含义 |
|---|---|---|
| `id` | 必填 | 注册表 id，也是每个解析身份携带的 `providerId`。 |
| `appId` | 必填 | 飞书开放平台 app id（`app_id`）。 |
| `appSecret` | — | 飞书 app secret，每次兑换时读取，轮换无需重载。 |
| `scopes` | `['contact:user.base:readonly']` | 浏览器授权请求的 scopes；应用必须被授予这些权限。 |
| `baseUrl` | `https://open.feishu.cn/open-apis/` | 飞书或 Lark API base；Lark 部署提供自己的 host。 |
| `requestTimeoutMs` | `30000` | 每次 token 与用户信息请求的超时。 |
| `defaultTenant` | — | 用户信息响应没有租户 key 时使用的租户 id。 |

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 适配器不做本地签名校验：飞书不返回 `id_token`，因此以 `app_secret` 认证的 HTTPS token 端点是权威来源。
- 授权重定向不转发 PKCE challenge；飞书改用 app secret 认证 token 请求。
- 应用必须被授予 `contact:user.base:readonly`（或所配置的 scopes），且其回调地址需在飞书控制台登记。

<a id="model-experience"></a>
## 模型体验

无。登录在浏览器完成，解析出的身份不会进入模型请求。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
