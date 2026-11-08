# Agent Note: 托管式多用户 Web：可插拔 OIDC 登录与按用户数据隔离

Status: implemented

[English](2026-11-05-hosted-multi-user-oidc-tenant-isolation.md) | 中文

## 问题

Web 形态在构造上就是单用户的。浏览器令牌鉴权（[browser-token-authentication](../../implemented/architecture/2026-08-24-browser-token-authentication.zh.md)）用一个启动令牌换取签名 Cookie，随后把每个已鉴权的浏览器都当作共享的 [`browserPeer`](../../../../packages/client/connection/src/rpc-host.ts) 放行，其 principal 是 `{ kind: 'owner' }`（[peer-principal-and-remote-access](../../implemented/architecture/2026-10-12-peer-principal-and-remote-access.zh.md)）。一个调用者身份就等于进程操作者，因此每个 Session、Workspace、设置、凭据与附件都属于同一个 home，共享服务器无法区分两个人。

## 决策

登录现在是一个三角色能力 seam，已鉴权的浏览器是被约束的 `user` 而不是操作者。承载它的是五个包角色：[`identity-protocol`](../../../../packages/identity/identity-protocol/src/index.ts) 里的身份三元组、其规范键与适配器接口；[`identity-providers`](../../../../packages/identity/identity-providers/src/index.ts) 里的 `identityProviders` 注册表；[`user-principal`](../../../../packages/identity/user-principal/src/index.ts) 里可合并扩展的 `user` principal 与其品牌化的 `userId`；[`identity-provider-oidc`](../../../../packages/identity/identity-provider-oidc/src/index.ts) 里的 OpenID Connect 适配器；以及 [`client-connection`](../../../../packages/client/connection/src/login.ts) 里的浏览器登录路由。

### 身份与放行

`user` principal 携带 provider/tenant/subject 三元组、显示名与可选头像地址；其规范分区键是 [`identityKeyOf`](../../../../packages/identity/identity-protocol/src/keys.ts) 的百分号编码三元组，品牌化为 `userId`。[BrowserAuth](../../../../packages/client/connection/src/browser-auth.ts) 仍然把 Cookie 绑定到本进程的授权，但签名 Cookie 现在指向一条持久化的 [`browser_sessions` 记录](../../../../packages/client/connection/src/storage.ts)：整个 principal、其键、provider、签发与过期时刻、以及一次性的 OAuth state；放行时为每条记录铸造一个 Peer。`/login?provider=<id>` 用一个一次性 state 与 PKCE S256 发起授权，`/login/callback` 消费该 state 并经已注册适配器兑换 code，`/logout` 删除记录，使下一个请求被拒绝。

`owner` 现在只表示进程操作者、本地单用户形态与受信任的进程内代码，且 `principalOf(invocation)` 对它仍返回 `undefined`，因此既有的每条非 owner 路径对 `user` 原样适用。

### OIDC 适配器

[`dsh-identity-provider-oidc`](../../../../packages/identity/identity-provider-oidc/src/index.ts) 基于 discovery 文档或三个显式端点实现该适配器，用 issuer 公布的密钥以 RS256 校验返回的 id_token，并在从配置的 claim 或默认值解析租户之前校验 issuer、audience、过期时间与 subject。配置了客户端密钥时，它用 HTTP Basic 认证令牌请求，并在每次兑换时读取密钥，因此轮换后的值无需重载即生效。部署提供 `issuer` 与 `clientId`，可选地提供端点、scopes、租户 claim 与默认租户；bundle 中该行以 `disabled: true` 出厂，因此未启用任何 provider 的部署保持单用户 loopback 行为。

### 按用户限定

[`home-paths`](../../../../packages/util/home-paths/src/index.ts) 新增了 `userHomePath(userKey, ...segments)` —— 即 `<DSH_HOME>/users/<userKey>` 根 —— 以及可选执行的 `migrateLegacyRootToUser(legacyRoot, targetUserRoot)` 迁移：它把 legacy 根下的每个直接子项改名搬入按用户根，并在目标子项已存在时于动手前拒绝。

[`SessionQueryEngine`](../../../../packages/session-query/session-query/src/index.ts) 通过 `principalOf(ctx.invocation)` 解析调用者，并把列表、精确读取、过滤、追踪与投影限定在物化位置位于调用者根下的持久化记录；`user` 既拿不到活会话，也拿不到没有位置的记录。[`WorkspaceRegistry`](../../../../packages/workspace/workspace/src/index.ts) 在新建 workspace 时打上 `owner`，把 `get`、`list`、归档与置顶 getter 以及每个变更限定在携带调用者键的记录上，并提供 `workspacesOwnedBy` 与 `sessionsOwnedBy`，使访问策略无需逐次扫描即可绑定归属。

### 鉴权

[`remote-access`](../../../../packages/api/remote-access/src/user-policy.ts) 提供 `createUserAccessPolicy`，[`WorkspaceController`](../../../../packages/api/workspace-controller/src/index.ts) 从其归属索引把它注册为 `user` 策略。用户在共享 UI 表面上持有 `global` 角色，并恰好在「归属 id 解析为自己的键」的资源上持有 Session 角色与 Workspace 角色，因此指向别的 id 什么也访问不到；仅 owner 的命名空间不会解析出任何用户绑定，继续保持拒绝。

### 安全不变量

- 只有进程内 Host 代码在铸造 Peer 时提供 principal；任何线上字段、Cookie、请求头或参数都无法覆盖它。
- 已鉴权的浏览器是 `user`，绝不是 `owner`；`owner` 是进程操作者。
- 一个适配器只占一个 provider id，一条会话记录只绑定该 provider 的三元组。
- 按用户根只由规范百分号编码三元组派生；provider 或 subject 为空的 principal 无效，解析不出租户的令牌被拒绝。
- 被撤销或已过期的会话记录拒绝放行，登出即删除记录。
- `user` 只能通过列出其全部允许动作的绑定，访问归属解析为自己键的资源。

### 本次发布不做的事

限定发生在注册表与查询层：session 持久化与存储后端仍写在 bundle 配置指定的位置，因此服务多个人的部署必须自行按用户路由这些写入，并执行[升级指南](../../../../docs/upgrade-guide/v0.2.2-alpha.3/per-user-data-partition/guide.zh.md)所述的迁移。附件、凭据与设置仍是进程级的。只有通用 OIDC 适配器出厂；Lark、GitHub 或 DeepSeek Platform 的专属适配器是实现同一接口的独立 provider 插件。

## 后果

通过已配置 provider 登录的人只读到自己拥有的 Session 与 Workspace，操作者保留完整的全局视图，两种身份不再坍缩成同一个 Peer。持久化会话记录让登出与过期即时且集中，这是裸签名 Cookie 做不到的，也让登录 seam 可测试：适配器只是带三个方法的值。

代价是一层运行时身份 seam，以及每次列表与读取上的一次作用域解析：调用者从 invocation 读取，限定列表按物化位置而非数据库谓词过滤持久化快照，因此 `user` 读不到活会话，没有位置的记录对该用户不可见。部署必须启用 provider 才有多个用户；没有 provider 时形态与从前完全一致。

残余风险留在部署侧。隔离只在部署真正按用户路由过的持久化根上成立，OIDC 适配器信任单一 issuer 文档并在插件生命周期内保留其公布密钥，被盗的 Cookie 在记录过期或登出删除之前一直有效。

## 备选方案

**用静态 patch 根做按用户 `DSH_HOME` 子目录。** `!!js` patch 表达式在启动时求值一次，那时还没有任何 principal，因此无法指认登录用户；分区改为在运行时发生，`userHomePath` 是每个消费者解析的运行时根。

**只在列表上加 repository 级的 `Scope` 过滤。** 只限定列表而不分区持久化状态，最敏感的记录仍然共享，等于用展示层隐藏而非隔离数据；本次发布分区根，并同时限定查询层与 workspace 注册表。

**单一硬编码 provider。** seam 让每个 provider 都是小的可选插件，部署按需启用适配器；硬编码一个 provider 会让此后每个来源都变成对 connection 层的改动。

**无状态 JWT 会话。** 没有中心记录的签名令牌无法在登出时撤销；持久化 `browser_sessions` 记录复用既有签名 Cookie 机制，免费获得撤销与过期。

**复用 `share-viewer` principal 做登录。** `share-viewer` 描述的是被令牌授予某个分享的查看者，而不是一个人拥有的数据；复用它会把分享与身份混为一谈，并把它按分享的字段硬塞进每条登录路径。

**每个用户一个服务器进程。** 共享服务器在一个绑定端口与一个 home 上服务多个浏览器用户；按用户分进程把隔离推给操作系统，并重新引入共享数据面本可避免的进程间协调。

## 与既有 Note 的关系

本 Note 部分取代两篇既有 implemented Note，两者均保持有效并在上文交叉链接。[Browser token authentication](../../implemented/architecture/2026-08-24-browser-token-authentication.zh.md) 仅在被取代的部分：Cookie 证明的是指向持久化会话记录的句柄而非 owner 身份，以及新增了登出；其授权绑定、启动令牌清理、持久化签名密钥与 `Secure` 随监听协议的结论仍是它的权责。[Peer principals and method-level Remote access control](../../implemented/architecture/2026-10-12-peer-principal-and-remote-access.zh.md) 仅在 `browserPeer` 始终携带 `{ kind: 'owner' }` 与「已鉴权浏览器即 owner」两点上被取代；principal/peer 拆分、默认拒绝、资源解析、列表过滤与来源记录均未改变，正是本 Note 依托的机制。[Account provider and active request cancellation](../../implemented/architecture/2026-09-17-account-provider-signout.zh.md) 相关但未被取代：它负责 DeepSeek 账号登出与模型路由的在途取消，本 Note 负责登录身份与会话撤销。
