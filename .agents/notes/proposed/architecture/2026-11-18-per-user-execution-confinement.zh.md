# Agent Note: 按用户执行约束

Status: proposed

[English](2026-11-18-per-user-execution-confinement.md) | 中文

## 问题

模型代表启动会话的当事人运行工具。在一个服务多人的进程里，执行路径中目前没有任何环节知道那是谁，因此工具的文件效应只由会话记录的 `cwd` 与部署的沙箱默认值支配。

三层决定工具可触碰什么，而每一层都有缺口。

**沙箱策略根**是 `session.header.cwd ?? this.workspaceRoot`（[`packages/sandbox/sandbox-policy/src/index.ts`](../../../../packages/sandbox/sandbox-policy/src/index.ts) 的 `resolve()`）。回退值是构造期读取一次的部署常量。因此不记录 `cwd` 的会话运行在部署根下，而在[用户工作区根边界](2026-11-18-user-workspace-root-boundaries.zh.md)之前设置了 `cwd` 的会话可能指向任意位置。

**权限模式**是按会话的、最后写入生效，来自记录的 `sandbox/mode` 事件。其取值集合包含 `danger-full-access`，会完全绕过约束。没有任何机制按 principal 约束该值，因此能触达权限界面的用户就能为自己的会话授予不受限的文件访问。

**持久存储**——工具写入所经过的 `attachment-local` 与 `spill-local`——今天是进程单例。它们的文件在同一个根下按内容寻址或按会话哈希命名，因此两人的工具输出共享一棵目录树。

`fs` 服务与 shell、terminal 工具从沙箱策略和会话工作目录解析其根，因此修好那两处就修好了消费它们的工具。缺口不在每个工具里；而在于没有任何一层知道调用者是谁。

## 提案

把调用者纳入每次策略解析，并按 principal 钳制模式。

### 策略携带边界

`SandboxPolicyService.resolve(request)` 接受已解析的边界，而不是仅从 `session.header.cwd` 推导根。输入保持 `{ session?, mode? }`，服务从环境 invocation 读取调用者——与[按用户 realm 分区](2026-11-18-per-user-realm-partitioning.zh.md) 路由所经的 `callerOf(ctx)` 同一条路径，因此边界与 realm 在构造上一致。

解析顺序变为：

1. 已批准的显式模式，不变。
2. 会话最后记录的模式，**按调用者上限钳制**。
3. 调用者边界作为 `workspaceRoot`。

由于每个 realm 挂载自己的 `sandbox-policy`，其 `workspaceRoot: userHomePath(key, 'workspaces')`，该 realm 中不记录 `cwd` 的会话已经解析到当事人自己的根。钳制是 realm 无法提供的那部分。

### 按 principal 钳制模式

`user` principal 最多能达到 `workspace-write`。`danger-full-access` 对 operator 与进程内代码保持可用，而请求它的既有升级界面本就位于那里——`plugin-manager` 明确点名它（[`packages/boot/plugin-manager/src/tools.ts:107`](../../../../packages/boot/plugin-manager/src/tools.ts)），`tool-cordis` 允许调用者请求它。

钳制是降级，不是拒绝：最后记录模式为 `danger-full-access` 的用户会话解析为 `workspace-write`。拒绝会让一个被替换的模式以一个模型无法据以行动的错误失败，而降级让回合在部署承诺的边界内继续运行。降级必须可见——已解析策略正是模型读取为文件策略上下文的内容，因此提示陈述的是生效模式而非请求模式。

钳制属于 `resolve()`，即每个消费方在执行前都会调用的那项操作。改为在权限界面强制会让 PTC runtime 落在检查之外，因为它会写入自己的 `sandbox/mode` 事件（[`packages/core/tool-executor-ptc/src/ptc-calls.ts:23`](../../../../packages/core/tool-executor-ptc/src/ptc-calls.ts)）。

### 额外可写根遵循同一规则

`additionalWritableRoots` 是部署配置并保持固定。用户 realm 不得继承当事人边界之外的根，因此 realm 模板要么省略该字段，要么设置在 `users/<key>` 下。需要共享只读语料的部署属于文件系统服务的读策略，而不是某个不受约束工具的可写根。

### 持久存储移入 realm

按[按用户 realm 分区](2026-11-18-per-user-realm-partitioning.zh.md)，`attachment-local` 与 `spill-local` 是 realm 行，因此其文件落在 `users/<key>` 下。这正是内容寻址变得安全的地方：引用是一个哈希，而哈希只有在解析它的存储可达时才是读能力。两个 realm 从不共享存储，因此从一个人会话泄漏的引用在另一个人的 realm 中解析不出任何东西。

### 核实工具表面

触及文件系统的工具必须逐一确认从 realm 解析其根：

| 工具 | 解析什么 | 检查归属 |
|---|---|---|
| `tool-fs`、`tool-fs-search`、`tool-str-replace-editor` | 带会话 cwd 的 `ctx.fs` | `fs` 后端 + 会话 cwd |
| `tool-bash`、`tool-pwsh` | 沙箱策略 argv 包装 | `resolve()` 钳制 |
| `tool-terminal` | 按会话的沙箱策略 | `resolve()` 钳制 |
| `working_directory` | `workingDirectory.set` | 来自[用户工作区根边界](2026-11-18-user-workspace-root-boundaries.zh.md)的边界检查 |
| `tool-fs` 读附件 | `attachment-local` 存储 | realm 存储 |

任何通过 root realm 解析这些之一的工具都是泄漏。`leakedServices` 能抓住从 realm 挂载发布到 root realm 的服务，但抓不住本应被 realm 作用域化的 root realm 消费方，因此本表是评审义务而非机械门禁——这正是验收标准为每一行点名一个跨用户探针的原因。

## 备选方案

**仅靠进程级沙箱约束并放弃进程内检查。** 既有沙箱后端已经把子进程限制在一个根内。它们只覆盖 shell 与 terminal 调用，其他一律不覆盖：`fs`、附件读取与模型自己的文件工具都从不离开进程。已拒绝：只覆盖了表面的一部分。

**在 `danger-full-access` 上拒绝而非降级。** 拒绝对意图是诚实的，但该模式会被并非用户编写的工具替换——`auto-review` 设置权限预设（[`packages/experimental/auto-review/src/index.ts:794`](../../../../packages/experimental/auto-review/src/index.ts)）——因此拒绝会让当事人无法诊断的回合失败。降级守住了边界；可见性要求承载了诚实性。

**给每个人各自的 OS 用户并依赖文件权限。** 这是最强的边界，也正是让多进程启动器等效于隔离的做法。它需要部署为每个人持有账户，而单进程决策排除了这一点。

## 验收标准

- 最后记录模式为 `danger-full-access` 的用户会话解析为 `workspace-write`，且模型可见的策略文本陈述 `workspace-write`。
- operator 与之前一样解析 `danger-full-access`。
- 未记录 `cwd` 的用户会话把其可写根解析为 `users/<key>/workspaces`。
- 用户 A 的模型无法通过 `fs` 读、`bash` 的 `cat`、`terminal` 或附件引用中的任一路径读取 `users/<keyB>` 下的文件。
- 用户 A 的模型无法通过上述任一途径写入 `users/<keyB>`。
- 工具表的每一行都由一个以某用户运行并断言对另一用户树拒绝的探针覆盖。
- realm 不报告任何泄漏到 root realm 的服务。

## 风险

**降级对 API 调用者是静默的。** 已解析策略对模型可见，但一个请求 `danger-full-access` 却因权限原因读到工具失败的客户端必须推断出钳制。受约束工具返回的拒绝消息已携带升级指引；该指引现在指向一个部署会再次钳制的请求，因此消息必须点名上限，而不是提供该升级。

**Windows ACL 物化。** `sandbox-local` 的 Windows 后端按工作区根物化每会话 ACL 授权（[`packages/sandbox/sandbox-local/src/index.ts:406`](../../../../packages/sandbox/sandbox-local/src/index.ts)）。按用户根会倍增这些授权，而该后端中常驻的按工作区授权假设是为单根部署编写的。

**边界与 realm 可能不一致。** 两次独立解析——realm 的 `workspaceRoot` 配置与策略计算的边界——可能漂移。它们必须读取同一个辅助函数，且必须有测试断言相等，而不是由部署相信两个字面量恰好匹配。

**读路径仍比写路径宽。** `fs` 读取由沙箱策略的模式支配，而 `read-only` 模式允许读取必需的 sink。把读取限制在当事人根下的设计会破坏每个读取系统头文件或包文件的工具。本提案约束写入与进程效应；它不试图让一个人的文件系统对另一个人的工具读取不可见，而这一限制必须被陈述而不是被假定。
