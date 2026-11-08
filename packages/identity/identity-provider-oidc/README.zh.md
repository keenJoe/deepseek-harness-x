---
description: "添加由部署配置的 OpenID Connect 身份提供方，把托管 Web 登录解析为一位经过校验的真实用户。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-identity-provider-oidc

[English](README.md) | 中文

## 概述

`dsh-identity-provider-oidc` 在 `ctx.identityProviders` seam 上注册一个 OpenID Connect 身份提供方：托管 Web profile 让浏览器在部署自己的 issuer 完成登录，并且只有在返回的 `id_token` 本地校验通过后才接入会话。该行默认关闭：issuer 与 client id 属于部署事实，因此由 profile patch 随配置一起启用。注册 provider 会改变浏览器准入方式：未认证的浏览器会被送到登录路由，而不是直接获得 owner 访问权限。仅接受 RS256 签名的 token，issuer 轮换密钥后需要重载插件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 启用该行

[`cordis.patch.yml`](cordis.patch.yml) 以 `disabled: true` 插入 `identity-provider-oidc` 行且不带配置，因为 issuer 与 client id 由部署决定。在 profile patch 中用 `disabled: false` 与自己的 `config` 覆盖该条目即可启用，且该 profile 需已挂载 Web server 与身份提供方注册表。

```yaml
- id: identity-provider-oidc
  disabled: false
  config:
    id: corporate
    issuer: https://login.example.com
    clientId: dsh-web
    defaultTenant: example
```

配置里的 `id` 就是注册表 id：它决定 `?provider=` 选中的 provider，是注册表中的键，并成为每个已解析身份携带的 `providerId`。Cordis 条目 id 始终是 `identity-provider-oidc`。

### 配置

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `id` | 必填 | 注册表 id，也是记录在每个已解析身份上的 `providerId`。同一 id 的第二次注册会被拒绝。 |
| `issuer` | 必填 | 期望的 `id_token` `iss` 取值，也是发现文档的基地址。 |
| `clientId` | 必填 | OAuth client id。 |
| `clientSecret` | — | 可选密钥。设置后 token 请求以 HTTP Basic（`client_secret_basic`）认证；公开客户端不要设置。该值在每次兑换时读取，轮换后无需重载。 |
| `scopes` | `['openid', 'profile', 'email']` | 浏览器授权请求的 scope。 |
| `authorizationEndpoint` | 自动发现 | 授权端点。需与 `tokenEndpoint`、`jwksUri` 一起配置；否则三者均取自发现文档。 |
| `tokenEndpoint` | 自动发现 | token 端点，属于同一组全有或全无的配置。 |
| `jwksUri` | 自动发现 | 用于校验 `id_token` 的 JWKS 端点，属于同一组全有或全无的配置。 |
| `requestTimeoutMs` | `30000` | 每次 issuer、JWKS 与 token 请求的时限。 |
| `defaultTenant` | — | token 未携带 tenant 声明时使用的 tenant id。 |
| `tenantClaim` | — | 命名 tenant 的 `id_token` 声明。 |

未配置全部三个端点时，插件在加载期间读取 `<issuer>/.well-known/openid-configuration`：issuer 不可达或只配置了部分端点会让加载失败，而不是等到首次登录；发现文档中的 `issuer` 必须与配置值一致。`tenantClaim` 与 `defaultTenant` 都无法确定 tenant 时，登录被拒绝，而不是归入猜测的 tenant。

### 浏览器登录

`GET /login?provider=<配置 id>` 启动流程。只注册了一个 provider 时，不带参数的 `/login` 会选中它；其他选择返回 `400`。[连接层登录流程](../../client/connection/README.zh.md)生成一次性 `state` 与 PKCE S256 challenge，重定向到 issuer 的授权端点，并在 `/login/callback` 完成：该路径用匹配的 code verifier 重复兑换请求。注册了 provider 的部署不再把未认证浏览器当作 owner 准入。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入这条关闭的行。`src/index.ts` 实现 seam 中与 provider 无关的 `IdentityProvider`，并在一个 effect 内通过 `ctx.identityProviders.register(id, adapter)` 注册，因此注册随加载它的 fiber 一同撤回。`authorizationUrl` 用配置的 `clientId` 与 scopes、回调 URL、登录流程的一次性 `state` 以及 S256 `code_challenge` 构造 issuer 重定向；`exchange` 携带匹配的 `code_verifier` 提交 code 并解析身份。未配置静态端点时，发现过程在插件的服务初始化中完成，因此加载会等待 issuer。

校验在本地完成。插件读取 issuer 的 JWKS 并缓存，按 token 头部的 `kid` 选出密钥，用 `node:crypto` 以 RS256 校验 `id_token` 签名；随后要求 `iss` 等于配置的 issuer、`aud` 包含 `clientId`、`exp` 尚未过期、`sub` 存在。解析出的身份以配置 `id` 作为 `providerId`、以 `sub` 作为 `subjectId`，显示名依次取 `name`、`preferredUsername`、`sub`，头像取自 `picture`，tenant 取自 `tenantClaim` 声明（存在时），否则取 `defaultTenant`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [身份](../../identity/README.zh.md)——这些身份包所属的包组。
- [身份提供方注册表](../identity-providers/README.zh.md)——本包注册进的注册表。
- [身份协议](../identity-protocol/README.zh.md)——本 adapter 实现的、与 provider 无关的授权与兑换类型。
- [Web bundle](../../bundle/web-app/README.zh.md)——本 provider 收窄其浏览器准入的稳定 profile。
- [连接层](../../client/connection/README.zh.md)——驱动该流程的 `/login` 与 `/login/callback` 路由。

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器登录

#### 模型看到什么

什么都不看。provider 只响应浏览器登录请求：它不贡献 prompt 段落、工具 schema 或结果文本，解析出的 `IdentityActor` 进入浏览器会话记录，而不是模型请求。

#### Token 影响

零直接 token。登录不消耗模型请求，已解析身份也不会给下一次请求增加内容。

#### KV Cache 影响

独立。不改变任何模型请求，因此本包不会让任何可复用的前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **JWKS 在每个插件生命周期内只获取一次**——issuer 轮换签名密钥后，插件重载之前校验都会失败。
- **只接受 RS256**——用其他算法签发 `id_token` 的 issuer 会被拒绝。
- **该行默认关闭且不带配置**——启用它的 profile 必须提供自己的 issuer 与 client，并且启用后浏览器准入从 owner 访问变为 provider 登录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
