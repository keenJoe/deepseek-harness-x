---
description: "托管多用户登录的身份提供方注册表：由部署选择的 OIDC/SSO 适配器把每次浏览器登录解析为一个已登录用户。"
kind: "package-reference"
---

# @deepseek-ai/dsh-identity-providers

[English](README.md) | 中文

## 概述

`dsh-identity-providers` 让托管部署通过一个或多个 OIDC 或 SSO 身份提供方让人登录，取代内置的单用户 loopback。你为每个身份源挂载一个提供方插件并注册其适配器（使用一个稳定 id），登录流程随后把每次浏览器回调解析为那个已登录的人。当不同的人必须只看到自己的工作时选择它。本包自身不提供任何提供方，一个也不启用的部署保留单用户 loopback。

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

本包是产品中保存托管登录所提供身份源的部分：提供方插件为每个身份源注册一个适配器，登录流程通过该适配器解析浏览器回调。常见路径很明确——为你部署提供的每个身份源注册一个适配器，然后让登录流程按 id 选择一个。

### 何时使用

当部署必须让不同的人通过可插拔身份提供方登录时使用它——通用 OIDC、飞书/Lark、GitHub、DeepSeek Platform，或本地运行的 mock——以便每个人只看到自己的工作。若部署是单用户，不要挂载任何东西到此 seam：没有注册适配器时它保持惰性，内置单用户 loopback 不变。提供方插件是可选的，因此部署只选择它需要的来源。

### 注册提供方

提供方插件为每个身份源声明一个适配器，以 id 为键，该 id 同时也是记录在每个已解析身份上的 `providerId`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { IdentityActor, IdentityProvider } from '@deepseek-ai/dsh-identity-providers'

declare const ctx: Context
declare const exchangeWithIssuer: (code: string, redirectUri: string) => Promise<IdentityActor>

const adapter: IdentityProvider = {
  id: 'example-oidc',
  scopes: ['openid', 'profile'],
  authorizationUrl(request) {
    const url = new URL('https://idp.example/authorize')
    url.searchParams.set('client_id', 'client')
    url.searchParams.set('redirect_uri', request.redirectUri)
    url.searchParams.set('state', request.state)
    url.searchParams.set('scope', request.scopes.join(' '))
    return url
  },
  async exchange(request) {
    return exchangeWithIssuer(request.code, request.redirectUri)
  },
}

const dispose = ctx.identityProviders.register('example-oidc', adapter)

ctx.identityProviders.list()              // ['example-oidc', ...] in registration order
ctx.identityProviders.get('example-oidc') // the adapter above, or undefined
dispose()                                 // unregister the adapter
```

适配器声明一个稳定 id、它请求的 scopes，以及把回调转成已登录身份的 authorization/exchange 方法。注册的 id 必须非空、与适配器自身的 id 一致，适配器必须声明至少一个 scope；任一检查失败的注册会在发布任何内容前抛出 `IdentityProviderError`（code `INVALID_PROVIDER`）。用同一 id 注册两次抛出 `DUPLICATE_PROVIDER`。`list()` 按注册顺序报告 id，`get()` 按 id 解析一个适配器，二者都从活动注册表回答，因此已释放的适配器会立即停止出现。

### 可能出错

- **空 id 或不一致的 id 注册失败**——`INVALID_PROVIDER`，因此注册表键与每个已解析身份携带的 `providerId` 始终一致。
- **不声明 scope 的适配器注册失败**——`INVALID_PROVIDER`，因此登录绝不会请求部署未审查过的内容。
- **用同一 id 注册两次抛出 `DUPLICATE_PROVIDER`**——一个适配器拥有一个 id，一次登录只绑定到该提供方。
- **没有注册适配器是惰性而非错误**——注册表为空时登录流程保留单用户 loopback；只有启用提供方的部署才改变行为。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 seam 背后的设计决策并指向实现它们的代码；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **seam 拥有注册表，绝不拥有协议。** 部署的身份源以注册适配器的插件形式出现；第二种协议以另一个适配器而非另一个 seam 出现，登录流程无需了解协议即可选择适配器。
- **适配器契约与提供方无关。** 适配器声明稳定 id、请求的 scopes，以及登录流程驱动的 `authorizationUrl`／`exchange` 对；seam 不构建跳转也不执行交换，因此能同样承载通用 OIDC、飞书/Lark、GitHub 与 DeepSeek Platform。
- **注册是原子的。** `register()` 在变更前验证并检查冲突：无效或冲突的注册不发布任何内容，其 disposer 随注册 fiber 一并释放 id。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition：id 到适配器的注册表、`register`／`list`／`get`、`IdentityProviderError` code |
| [`src/types.ts`](src/types.ts) | 从 `dsh-identity-protocol` 重新导出的适配器契约 |

### 注册生命周期

注册与释放通过 `ctx.effect()` 执行，因此提供方随注册 fiber 一同存活与消亡。`IdentityProviderError` 扩展普通 `Error`，携带稳定 code（`INVALID_PROVIDER`、`DUPLICATE_PROVIDER`），调用方据此路由而非解析 `message`；`isIdentityProviderError` 在运行时边界把捕获值收窄到该错误。seam 扩展普通 `Error` 而非更重的错误基类，使 identity 组保持轻依赖。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享身份契约逐步进入解析并据此划分的 principal。

- [identity 包组](../README.zh.md)——本注册表、身份契约与已登录用户 principal 的组地图。
- [dsh-identity-protocol](../identity-protocol/README.zh.md)——本注册表重新导出的、与提供方无关的 `IdentityProvider` 契约。
- [dsh-user-principal](../user-principal/README.zh.md)——登录流程解析出的、已登录 `user` principal 与规范 `UserId`。
- [能力 seam](../../../docs/capability-seams.zh.md)——本 seam 遵循的 Service Definition / Service Provider / Consumer 拆分。
- [托管多用户 Web](../../../.agents/notes/implemented/architecture/2026-11-05-hosted-multi-user-oidc-tenant-isolation.zh.md)——本 seam 所属设计的一个阶段。

-----

<a id="model-experience"></a>
## 模型体验

无，因为注册表持有的是托管登录流程的提供方适配器，任何适配器、提供方或登录状态都不会抵达模型请求。

#### KV Cache 影响

不失效；任何登录或身份状态都不会进入请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不合适或需要特别注意。它们是当前包约束，不是任务积压。

- **没有内置提供方**——注册表只持有提供方插件挂载的内容；一个都不挂载的部署保留单用户 loopback，托管登录需要至少一个提供方包。
- **注册仅在运行时**——启用的提供方集合取决于挂载并调用 `register()` 的插件；注册表不读取配置，也不自行选择默认提供方。
- **不存储会话或令牌**——注册表持有适配器，绝不持有登录会话或 IdP grant；持久化与吊销属于浏览器会话层与凭据 seam。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
