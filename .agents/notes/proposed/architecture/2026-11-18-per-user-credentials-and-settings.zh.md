# Agent Note: 按用户凭据与设置

Status: proposed

[English](2026-11-18-per-user-credentials-and-settings.md) | 中文

## 问题

部署决策是每个已准入的人自行提供模型凭据。今天凭据存储是整个进程的一份文档，而 Remote 策略拒绝已登录用户使用那批会写入它的端点。

`credentials-local` 把其文档解析为 `config.path ?? <harness-home>/.credentials.yaml`（[`packages/credentials/credentials-local/src/index.ts:90`](../../../../packages/credentials/credentials-local/src/index.ts)）。因此一个进程只有一份凭据文档，一个人的 key 就是每个人的模型请求所用的 key。

即便有了按用户存储，用户也够不到它。[`packages/api/remote-access/src/user-policy.ts`](../../../../packages/api/remote-access/src/user-policy.ts) 中的 `USER_GLOBAL_ROLE` 列出十四个动作，既不含 `credentials/*` 也不含 `settings/*`。对没有任何角色列出的端点，`explainUserRefusal` 报告 `user/no-access`，因此已登录用户的设置页根本无法读写 key。

设置还有第二个问题。`settings` 通过 `configEditor` 写入 profile patch（[`packages/boot/config-editor/src/index.ts:34`](../../../../packages/boot/config-editor/src/index.ts) 返回 `profileContext.patchPath`），那是每个 profile 一份的文件，同时也是组合文档。按用户往该文件写入会让一个人编辑其他人启动所用的组合。

模型选择界面让这一点变得具体：`agentDefaultModel` 通过同一个 `configEditor` 读写（[`packages/core/agent-default-model/src/index.ts:85`](../../../../packages/core/agent-default-model/src/index.ts)），因此"我的默认模型"与"部署的默认模型"是同一个值。

## 提案

三项变更，按依赖顺序。

### 1. 在调用者的 realm 内解析凭据与设置

[按用户 realm 分区](2026-11-18-per-user-realm-partitioning.zh.md) 为每个人挂载一个 `credentials-local`，其 `path: userHomePath(key, '.credentials.yaml')`。Remote 命名空间 `credentials` 与 `settings` 随后通过与路由其他所有私有服务相同的隔离绑定到达调用者的实例，因此不需要控制器改动，也不需要按调用解析根的逻辑。

没有 `user` principal 的调用保持 root 实例与部署文档，这仍是 operator 与进程内调用者所需要的。

### 2. 把用户设置文档与 profile patch 分开

按用户的设置写入不得到达 `profileContext.patchPath`。因此用户的 `settings` 实例需要自己在 `userHomePath(key)` 下的文档，且其 `configEditor` 绑定必须指向那里。

有两种可行的形态，选择归实现所有：

**每个 realm 一份限定作用域的文档。** `config-editor` 从拥有它的 Context 接受文档路径，而不是无条件读 `profileContext.patchPath`，realm 则挂载一个绑定到 `userHomePath(key, 'settings.yaml')` 的 `config-editor`。Loader 继续拥有根组合；realm 的编辑器拥有一人的值。

**一层显式用户层。** `settings` 为 `user` principal 增加第二个可写层，持久化在当事人数据旁，并在读取时合并在 profile 继承值之上。profile patch 对用户保持只读。

第一种复用既有写入路径，并原样继承其冲突检测与 volatile 字段校验。第二种保持一份组合文档，但为每次设置读取增加一个合并步骤。本提案采用第一种，因为它不改任何读取路径，且既有的 `SettingsConflictError` 版本检查按 realm 继续有效。

### 3. 准入按用户配置页所需的端点

`USER_GLOBAL_ROLE` 增加一个人自身配置页所调用的端点：

- `credentials/describe`、`credentials/set`、`credentials/unset`
- `settings/describe`、`settings/update`

授权问题不仅是用户可以调用哪个端点，还在于哪个实例来应答。两个命名空间都在调用者的 realm 内解析，因此 `credentials/set` 写入调用者的文档。这种配对——已准入端点加上按 realm 路由的实例——就是全部保证，且任一半单独都不充分。

`credentials/set` 不得经任何路径到达另一个用户的 realm。realm 注册表以从已认证 principal 推导的规范用户 id 为键，而从不以请求参数为键，因此没有任何参数能命名他人的 realm。

### 4. 把账户范围的状态排除在用户界面之外

`deepseek-account` 流转部署的 DeepSeek 账户状态（[`packages/account/deepseek-account/src/index.ts`](../../../../packages/account/deepseek-account/src/index.ts)）。那是部署的一个账户，不是按人的事实，因此保持仅 owner：策略继续对其解析不出绑定。

## 备选方案

**保留一份凭据文档并按用户命名空间化键。** 一个文件带 `users/<key>/DEEPSEEK_API_KEY` 分区能保持单一写入者与单一文件权限检查。它失去了"某人的密钥不在另一人的进程代码路径可读的文档里"这一性质，且需要一套每个未来凭据消费方都必须遵守的键命名约定。realm 改为保留文件边界。

**让用户写 profile patch 并按用户归属各分区。** 这正是 `settings` 今天对一个 owner 的做法。它违背组合要求：profile patch 是启动文档，一个人编辑它就是编辑每个人启动的东西。

**给用户 operator 的模型 key。** 它完全移除按用户凭据工作，是显而易见的廉价选项。部署决策要求每人自行提供，因此被排除；且它会让某人的用量限额或吊销与另一人无法区分。

## 验收标准

- 两个用户各自设置模型 key；`users/<keyA>/.credentials.yaml` 与 `users/<keyB>/.credentials.yaml` 各自只保存自己的值。
- 用户 A 的模型请求解析 A 的 key；B 的 key 从不出现在 A 的请求头中。
- 用户作出的设置写入落在该用户的文档，并让 profile patch 保持字节不变。
- 用户的设置页能列出并更新其命名空间；部署组合所属的任何命名空间对用户都不可写。
- 伪造 realm 参数的 `credentials/set` 无法到达另一个用户的文档；拒绝是策略或未找到错误，而不是静默写到别处。
- operator principal 仍然读写部署文档。
- 一项测试断言 `USER_GLOBAL_ROLE` 与 realm 路由一致：每个新准入的端点都解析到 realm 作用域的实例。

## 风险

**两份设置文档会分歧。** 部署设置的值与个人覆盖的值需要明确的优先级，否则个人页面显示的是模型并未使用的值。合并顺序——先部署继承，后用户覆盖——必须是唯一书面化的规则，而不是按命名空间各自解决。

**密钥脱敏现在按 realm 运行。** `settings.describe({ redactSecrets: true })` 是 wire 避免返回密钥的方式。泄漏未脱敏描述符的 realm 会把某人的 key 返回给该人的浏览器，这是正确的；返回给任何到达该 realm 的调用者则不是。脱敏路径仍是同一份代码；变化的是有多少实例在运行它。

**用户的 key 在首次使用前未经验证。** `ctx.deepseekAuth` 在请求时规范化已保存的 key（[`packages/account/deepseek-auth/src/index.ts`](../../../../packages/account/deepseek-auth/src/index.ts)）；拼写错误表现为失败的回合而不是被拒绝的保存。设置界面应在写入时验证，让当事人在能修复的时刻得知。

**吊销现在按人进行。** 清除部署 key 过去会一次禁掉所有用户。按用户存储意味着运维必须逐个文档处理才能吊销，而本提案没有对应的管理界面。
