# Agent Note: 用户工作区根边界

Status: proposed

[English](2026-11-18-user-workspace-root-boundaries.md) | 中文

## 问题

托管多用户 Web 允许数人进入同一个 harness，但三个入口接受来自浏览器或模型的绝对文件系统路径，且没有任何边界检查。三者合起来让一个已准入的人能让 harness 读写该进程可触及的任何位置。

`session.create` 把目录解析为 `workspace?.path ?? request.cwd ?? this.defaultCwd`（[`packages/api/session-controller/src/commands.ts:116`](../../../../packages/api/session-controller/src/commands.ts)）。`request.cwd` 来自浏览器，从不与任何根目录比较。回退值 `this.defaultCwd` 是 `process.cwd()`（[`packages/api/session-controller/src/index.ts:194`](../../../../packages/api/session-controller/src/index.ts)），因此部署还会继承启动器恰好所在的目录。

`workspace.create` 把 `request.path` 直接传给 `workspaceRegistry.create`（[`packages/api/workspace-controller/src/commands.ts:52`](../../../../packages/api/workspace-controller/src/commands.ts)）。该方法会规范化路径并要求目录已存在（[`packages/workspace/workspace/src/index.ts:240`](../../../../packages/workspace/workspace/src/index.ts)），这能拒绝拼写错误，但会接纳该进程可 stat 的任何目录。

模型自己就能移动边界。`working_directory` 工具把其 `cd` 参数转给 `workingDirectory.set`（[`packages/session/tool-working-directory/src/index.ts:36`](../../../../packages/session/tool-working-directory/src/index.ts)），而只要 `fs.stat` 报告这是个目录，`set` 就接受（[`packages/session/working-directory/src/index.ts:163`](../../../../packages/session/working-directory/src/index.ts)）。会话工作目录随后成为沙箱 `workspace-write` 根（[`packages/sandbox/sandbox-policy/src/index.ts`](../../../../packages/sandbox/sandbox-policy/src/index.ts) 的 `resolve()`），因此这次移动同时也放宽了可写根。

Remote 访问策略没有堵住这一点：`USER_GLOBAL_ROLE` 向每个已准入用户授予 `session/create` 与 `workspace/create`（[`packages/api/remote-access/src/user-policy.ts`](../../../../packages/api/remote-access/src/user-policy.ts)），所以上述路径在设计上就是可达的。

本工作的部署决策是：一个人的工作区根固定为 `<harness-home>/users/<userKey>/workspaces/`，不可选择。因此边界必须由已认证的 principal 推导，而不是由调用方提议。

## 提案

为每个调用者引入一个已解析的边界，并在做出决定的那项操作处强制执行。

**一个解析器。** 在 [`packages/identity/user-principal`](../../../../packages/identity/user-principal/src/index.ts) 中新增一个函数，返回某 principal 的工作区边界：

```ts
/** Absolute writable workspace boundary for one principal; the operator keeps the deployment root. */
export function workspaceBoundaryOf(principal: Principal): string
```

对 `user` principal，它返回 `userHomePath(String(userId(principal)), 'workspaces')`（[`packages/util/home-paths/src/index.ts:181`](../../../../packages/util/home-paths/src/index.ts)）。对 operator 与进程内代码，它返回配置的部署工作区根，从而保持单用户行为。

**`session.create`。** 用一步"先解析后创建"替换 `?? this.defaultCwd` 链：命名的 `workspaceId` 必须解析到调用者拥有的工作区，显式 `cwd` 必须位于调用者边界内，默认值改为边界本身而非 `process.cwd()`。边界外的请求以稳定错误码拒绝而不是钳制，因为静默重定向一个命名目录会让会话跑在调用者并未要求的位置。

**`workspace.create`。** 用现有的 `realpathNormalize` 规范化，并要求结果位于调用者边界内才允许注册。先规范化正是为了击败一个种在边界内、指向边界外的符号链接。

**`working_directory.set`。** 把边界作为显式参数接受，并拒绝边界外的目标。调用方——即 `working_directory` 工具——从 `agent.session` 解析边界，因此检查位于改变目录的那项操作，而不是工具里。

**`sandbox-policy.resolve`。** `workspace-write` 根已经跟随 `session.header.cwd`。一旦目录无法离开边界，沙箱根就继承该保证；剩余缺口是本变更之前创建的会话，其记录的 `cwd` 可能位于任意位置。因此 `resolve()` 把已记录的 `cwd` 钳制到调用者边界，当记录值在边界外时回退到边界。

`isWithinRoot` 已存在于 [`packages/identity/user-principal`](../../../../packages/identity/user-principal/src/index.ts)，并在路径分隔符边界处比较；上述每项检查都使用它，而不是字符串前缀测试。

## 备选方案

**允许部署配置一份额外根允许列表。** 它能保持"对我的既有检出版本跑会话"可用，但会重新引入受调用方影响的路径，需要自己的管理界面，并且与"工作区根固定"这一既定决策矛盾。本部署不采用；解析器为将来在不改调用点的情况下加入根集合留出了空间。

**钳制而非拒绝。** 把 `/etc` 转成调用者边界能让会话继续工作，但掩盖了调用者要求了可能无权访问的东西。命名路径是明确的意图，而边界检查是唯一能诚实应答该意图的地方。已拒绝。

**在 Web 层于 Remote 调用之前检查。** 浏览器不是唯一调用者：SDK、PTC runtime 与进程内代码都到达同样的端点。检查放在 Remote 边界之上会被每一个非浏览器调用者绕过，而能力接缝规则正把这种情况列为非强制。

## 验收标准

- `session.create` 传入边界外的 `cwd` 返回 `user/path-outside-root`，且不创建任何目录。
- `session.create` 命名另一个用户拥有的 `workspaceId` 返回同一拒绝。
- `workspace.create` 传入边界外路径返回该拒绝；边界内指向边界外的符号链接在规范化之后被拒绝。
- `working_directory` 工具拒绝 `cd /`、越过边界的 `cd ..`，以及边界外的绝对目标；拒绝以可操作的提示到达模型。
- 一个记录了边界外 `cwd` 的会话，其沙箱根解析到边界而非记录的目录。
- operator principal 与进程内调用者保持部署根；既有单用户部署不出现行为变化。
- 每项拒绝都通过 Remote 端点测试，而不只通过辅助函数。

## 风险

**既有会话。** 本变更之前创建的会话记录的 `cwd` 现在可能位于边界外。沙箱钳制阻止其放宽写入，但会话自身的项目目录仍在原处；运维可能需要把这类会话重建到 `users/<userKey>/workspaces/` 下。

**拒绝出现得较晚。** 边界在 `session.create` 处解析，因此习惯命名仓库路径的用户只在创建会话时遇到拒绝。提示必须点名允许的根，否则当事人无法判断该做什么。

**operator 根仍然很宽。** 本记录只约束 user principal。把 operator cookie 交给浏览器的部署会重新打开这里所有路径；一旦注册了 provider，托管登录已经拒绝 owner cookie（[`packages/client/connection/src/rpc-host.ts`](../../../../packages/client/connection/src/rpc-host.ts) 的 `admit()`），因此这两项决策互相依赖。
