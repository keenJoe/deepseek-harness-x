# Agent Note: 按用户 realm 分区持久状态

Status: proposed

[English](2026-11-18-per-user-realm-partitioning.md) | 中文

## 问题

一个为多人运行的单进程托管多用户 Web 部署共享同一批持久服务单例。它们每一个都在构造期从 harness home 解析自己的根：

| 服务 | 根 | 来源 |
|---|---|---|
| `session-persistence-jsonl` | `<home>/sessions` | [`packages/bundle/base/cordis.patch.yml:141`](../../../../packages/bundle/base/cordis.patch.yml) |
| `storage-json` | `<home>/storages` | [`packages/bundle/base/cordis.patch.yml:185`](../../../../packages/bundle/base/cordis.patch.yml) |
| `attachment-local` | `<home>/attachments/v1` | [`packages/attachment/attachment-local/src/index.ts:180`](../../../../packages/attachment/attachment-local/src/index.ts) |
| `spill-local` | 操作系统临时私有根 | [`packages/spill/spill-local/src/index.ts:88`](../../../../packages/spill/spill-local/src/index.ts) |
| `credentials-local` | `<home>/.credentials.yaml` | [`packages/credentials/credentials-local/src/index.ts:90`](../../../../packages/credentials/credentials-local/src/index.ts) |

读取侧已经假定按用户分区。对 `user` principal，`sessionQuery.listSessions`、`filterSessions` 与精确读取都把自身限制在 `users/<userKey>/**`（[`packages/session-query/session-query/src/index.ts:406`](../../../../packages/session-query/session-query/src/index.ts)），而 `workspaceRegistry` 按已打上的 `owner` 过滤记录（[`packages/workspace/workspace/src/index.ts:1010`](../../../../packages/workspace/workspace/src/index.ts)）。

写入侧从未跟上。`session-persistence-jsonl` 只解析一次配置的根（[`packages/session/session-persistence-jsonl/src/index.ts:326`](../../../../packages/session/session-persistence-jsonl/src/index.ts)），并把每个会话物化在其下，因此用户的会话落在 `<home>/sessions`，而其列表读的是 `users/<userKey>/sessions`。在一个服务多人的进程里，列表因此永久为空，且两人的会话共享同一目录树。

上一个版本承认了这一点：其[升级指南](../../../../docs/upgrade-guide/v0.2.2-alpha.3/per-user-data-partition/guide.zh.md) 说明注册表层的作用域"读取按用户的位置，但不改路由后端写入"，并把分区后端列为独立步骤。

本工作的部署决策是：一个进程、一个飞书应用、数个人，每人有自己的持久状态与自己的凭据。多进程监护（`serve-users` 与 `route-users` 启动器）因此不在范围内：它从进程边界获得隔离，而本部署没有该边界。

## 提案

通过为每个已登录用户挂载一个隔离的服务 realm 来分区，并把每次已认证调用路由进其 realm。

### 为何用 realm 而非按调用解析根

上述每个后端都把根作为已验证配置并在构造期解析一次。教它们按调用解析根意味着要在五个包中修改 `create`、`open`、`list`、`stat` 以及未来的每个方法，并且会让 `list()` 的语义变得含混——它列出调用者的会话还是整个存储。realm 不改动其中任何一个：调用到达的服务实例已经持有正确的根。

Cordis 已支持这一点。`Context.isolate(name, label)` 让一个服务名在每个隔离标签下拥有不同实现（[`vendor/cordis/src/context.ts:121`](../../../../vendor/cordis/src/context.ts)），而 preset 挂载逻辑把从隔离子树发布到 root realm 的服务视为泄漏并拒绝挂载（[`packages/preset/agent-preset-registry/src/mount.ts:213`](../../../../packages/preset/agent-preset-registry/src/mount.ts)）。正是这项审计让 realm 的边界可被检查，而不是一种约定。

### 注册表

一个新服务拥有这些 realm：

```ts
import { Service, type Context } from '@deepseek-ai/cordis'
import type { UserPrincipal } from '@deepseek-ai/dsh-user-principal'

/** One isolated durable-service realm per logged-in person. */
export abstract class UserRealmRegistry extends Service {
  /**
   * @param user - the authenticated principal.
   * @returns the realm serving this person, created on first use.
   */
  abstract obtain(user: UserPrincipal): Promise<Context>
}
```

`obtain` 以 `String(userId(user))` 为键，即其余分区代码使用的同一个规范 `provider:tenant:subject` 键。创建时把一份固定的行模板挂载进新的 `isolate` 作用域：

- `session-persistence-jsonl` → `root: userHomePath(key, 'sessions')`
- `storage-json` → `root: userHomePath(key, 'storages')`
- `attachment-local` → `dshHome: userHomePath(key)`
- `spill-local` → `root: userHomePath(key, 'spill')`
- `credentials-local` → `path: userHomePath(key, '.credentials.yaml')`
- `settings` 与 `config-editor` → 作用域限定为 `userHomePath(key)`
- `sandbox-policy` → `workspaceRoot: userHomePath(key, 'workspaces')`

模板是数据，不是第二份组合：注册表挂载一个行数组，因此新增一个持久后端只需一条条目，而不是改动隔离逻辑。

创建按 key 幂等且单飞。并发的首个请求不得挂载两个 realm，因此 `obtain` 为每个 key 保留一个 promise 并返回该 promise，遵循代码库对"一个异步操作由一个生命周期所有者表示"的规则。

### 把调用路由进其 realm

Gateway 已经构造了按调用的 Context：[`packages/api/gateway/src/index.ts:858`](../../../../packages/api/gateway/src/index.ts) 绑定 `this.ctx.invocation`，使服务把该调阅读作自己的调用。路由是在该 Context 上再加一步——隔离私有服务名并把它们绑定到调用者的 realm——此后每个下游的 `ctx.get('sessionPersistence')`、`ctx.get('credentials')` 或 `ctx.get('sandboxPolicy')` 都解析到调用者的实例，而无需改动任何调用点。

没有 `user` principal 的调用——operator、进程内代码、测试——保持 root realm，因此单用户部署观察到与今天相同的组合。

### realm 不分离什么

`ctx.sessions` 与 `ctx.agents` 是以 `SessionId` 而非人为键的注册表，且实时会话驻留内存。realm 不隐藏它们。这些资源的授权归 Remote 访问策略，即[用户资源授权](2026-11-18-user-resource-authorization.zh.md)的主题。

## 备选方案

**通过每人一个进程恢复分区隔离。** 已发布的 `serve-users` 与 `route-users` 启动器正是这么做，且进程边界强于服务 realm。已拒绝，因为部署决策是一个进程：它同时保持一个登录入口和一个共享端口，而双进程模型在没有身份路由代理时无法做到——该代理的 `/api` 与 WebSocket 转发尚未实现（[`packages/host/route-users/src/index.ts`](../../../../packages/host/route-users/src/index.ts) 占用 fallback 席位，而具名的 `/api` 前缀路由永远不会到达它）。

**保留全局存储并按 owner 过滤每次读写。** 会话需要在头部加一个 owner 字段，且每个后端都需要一个它没有的过滤器——包括 `list()`、`stat()` 与崩溃修复，它们靠扫描目录而非读头部来恢复日志。它还让一次损坏或错误作用域的写入能够跨越边界。已拒绝：更多表面、更弱的保证。

**只分区会话存储，让附件与 spill 保持全局。** 这两者是按内容寻址的：附件引用是哈希，因此获知他人引用的用户能读到其字节。保持共享与"一个人的工作不会触达另一个人的"这一要求矛盾。

## 验收标准

- 两个已准入用户各创建一个会话；其日志分别物化在 `users/<keyA>/sessions` 与 `users/<keyB>/sessions`，且彼此的列表都不显示对方的会话。
- 每个用户的 `storage`、`attachments` 与 `spill` 文件落在各自的根下。
- 在并发首个请求下单飞地每个 key 只创建一个 realm；销毁后不留下已注册的服务。
- `leakedServices` 对已挂载 realm 报告为空，证明私有行留在隔离边界内。
- 无 `user` principal 的调用解析 root realm，且行为与之前完全一致。
- 注册表在自身 fiber 卸载时销毁每个 realm，且已销毁的 realm 拒绝后续调用，而不是从已拆解的上下文继续服务。

## 风险

**realm 生命周期是新的共享状态。** 一个 context 注册表正是包规则所警告的那类全局状态。它必须由服务拥有、以规范用户 id 为键、并随其 fiber 销毁；以 principal 为键的 `WeakMap` 或模块级 map 会隐藏其所有者。

**内存随已准入用户增长。** 每个 realm 持有自己的后端、缓存与文件监视器。空闲用户销毁策略是真实需求，但需要自己的决策——与进行中回合竞争的驱逐会让某会话的写入搁浅。

**既有数据的迁移。** 已写入全局 `<home>/sessions` 的会话从任何 realm 都不可达。`migrateLegacyRootToUser` 把一个遗留根移入一个用户根，但当目标子项已存在时它会拒绝，且无法按 owner 分区一棵共享树。已经从一个 home 服务多人的部署会有无法归属的会话。

**监视器倍增。** `credentials-local` 监视其文档，`storage-json` 按域打开句柄。每个 realm 都增加自己的；操作系统的 inotify 或 kqueue 预算成为当前单 realm 代码从未遇到的部署上限。
