---
description: "DeepSeek Harness 主目录与共享 agent 配置根目录的共享解析，以及用户数据路径、波浪号展开与稳定监听路径。"
kind: "package-library"
---

# @deepseek-ai/dsh-home-paths

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-home-paths` 让包作者能够解析 DeepSeek Harness 数据根目录，以及其消费方读取的共享 agent 配置根目录。显式路径优先于环境变量，后者优先于操作系统主目录下的默认值；空白环境变量会被忽略。其公开辅助函数可以解析某个已登录用户在 `users/<userKey>` 下的按用户根目录、把旧 owner 主目录迁移进去、在不暴露机器绝对路径的情况下显示根目录、仅展开单独或当前用户的波浪号形式，并规范化最终路径段尚不存在的监听目标。请把它作为库依赖直接使用，不要通过 `cordis.yml` 加载。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当包必须与 harness 的其他部分就用户数据存放位置达成一致时使用这些辅助函数：先解析一次主目录，再从中派生所有子路径。

### 解析主目录

```ts
import { resolveDshHome, dshHomePath, dshCachePath } from '@deepseek-ai/dsh-home-paths'

const home = resolveDshHome()                // configured path, else $DSH_HOME, else ~/.dsh
const settings = dshHomePath('settings')     // join one child onto the resolved home
const cache = dshCachePath('models')         // $DSH_HOME/cache/models, default ~/.dsh/cache/models
```

显式配置的路径优先级最高，然后是 `$DSH_HOME`，最后是默认的 `~/.dsh`。空或仅含空白的 `$DSH_HOME` 视为未设置，因此空白的覆盖值绝不会把主目录解析到当前工作目录。

`dshCachePath(...segments)` 从解析出的主目录下的 `cache` 目录派生路径。不传路径段时返回缓存目录本身。传入首个选项对象 `dshCachePath({ dshHome: home }, ...segments)` 可使用显式配置的主目录，遵循相同的优先级与波浪号展开规则。它返回绝对路径，不会创建目录。

### 解析共享 agents 根目录

```ts
import { resolveAgentsHome, agentsHomeDisplay } from '@deepseek-ai/dsh-home-paths'

const agents = resolveAgentsHome()   // configured path, else $DSH_AGENTS_HOME, else ~/.agents
agentsHomeDisplay(agents)            // ~/.agents, or $DSH_AGENTS_HOME for any configured root
```

`resolveAgentsHome` 采用与 `resolveDshHome` 相同的优先级、空白值处理与波浪号展开。该根目录刻意位于 `$DSH_HOME` 之外，因为其他 agent 工具也会共享它：`dsh-agent-instructions` 读取其中的用户全局 `AGENTS.md`，`dsh-skill-filesystem` 扫描其中的 `skills/` 目录。

### 按用户分区数据

`userHomePath(userKey, ...segments)` 把规范的百分号编码用户 key 拼到解析后的主目录下，得到 `<home>/users/<userKey>`，使某个已登录用户的持久化根目录都位于一个遍历安全的目录下。key 由 identity 包（`identityKeyOf`）生成，绝不来自调用方可控的路径输入；从 principal 派生 key 的调用方必须先拒绝空的 provider 或 subject。这是纯路径拼接：它既不校验也不创建任何内容。

`migrateLegacyRootToUser(legacyRoot, targetUserRoot)` 把旧 owner/全局主目录的每个直接子项移动到按用户根目录，旧目录本身保留在原地但被清空。它是一次性的显式操作：逐个 rename 子项，当任一目标子项已存在、或源目录缺失时在改动任何内容之前拒绝，并且只在全部冲突检查通过后才创建目标目录。请在分区迁移时显式调用它——绝不在每次启动时调用。

### 展示主目录

面向用户的路径请以符号形式渲染根目录，而不是机器路径：默认主目录显示为 `~/.dsh`，任何已配置的主目录显示为 `$DSH_HOME`，默认共享 agents 根目录显示为 `~/.agents`，任何已配置的共享 agents 根目录显示为 `$DSH_AGENTS_HOME`。两种展示形式都不会泄露机器的绝对路径。

### 展开用户路径

`expandHomePath` 针对操作系统主目录展开开头的 `~`、`~/` 或 `~\`，其余内容原样保留——非波浪号路径以及 `~alice/...` 等指定用户的形式不做任何改动。

### 规范化监听路径

`canonicalizeWatchPath` 为原生文件系统 watcher 提供目标路径的一种规范化写法：先通过 `realpath` 解析层级最深的现有祖先，再拼回缺失的后缀，因此文件或目录在创建之前就可以被监听。这可以防止 Windows 把普通文件祖先当作普通缺失处理，也防止 8.3 短名别名与原生 watcher 后端发出的长路径混用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包建立在一个原则上：harness 的用户数据位于同一个根目录下，而共享 agent 配置根目录保持独立，因为其他 agent 工具也会读取它。`resolveRoot` 与 `rootDisplay` 负责两个根目录的优先级与展示规则，因此两者不会彼此漂移。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 主目录解析、按用户路径拼接、旧数据迁移、展示、波浪号展开与监听路径规范化 |

### 解析规则

`resolveDshHome` 先读显式覆盖值，然后读 `$DSH_HOME`，最后回退到操作系统主目录拼接 `.dsh`。`resolveAgentsHome` 对 `$DSH_AGENTS_HOME` 与 `~/.agents` 读取同样的三层值。选中的值经过波浪号展开并规范化为绝对路径；`dshHomePath` 用 Node 的平台路径规则拼接子路径段。`dshHomeDisplay` 与 `agentsHomeDisplay` 把解析出的路径与默认根目录比较并返回符号标签，因此已配置的根目录绝不泄露其绝对路径。`userHomePath` 用同一个解析出的主目录派生按用户根目录，`migrateLegacyRootToUser` 把旧主目录的直接子项 rename 到其下，且从不删除源目录。

### 规范化机制

`canonicalizeWatchPath` 从目标向上逐级查找，直到找到现有祖先，用 `realpath` 解析它、证明它是可枚举目录，再拼回缺失的后缀。除路径不存在以外的错误都会传播；缺失后缀的祖先若不是目录则被拒绝。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你需要启动器或依赖统一主目录根的消费方时，阅读以下页面。

- [boot 包](../../boot/app-boot/README.zh.md)——在任何插件挂载之前解析主目录的启动器。
- [shell 环境](../../shell/shell-env/README.zh.md)——`DSH_HOME` 如何到达模型 shell 调用。
- [匿名用户 id](../../identity/anonymous-user-id/README.zh.md)——位于解析后主目录下的存储身份文件。

-----

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明这些辅助函数何时不是合适的工具。它们是当前包约束，不是任务积压。

- **展开范围刻意保持狭窄**——只有单独的 `~`、`~/...` 和 `~\...` 使用当前操作系统主目录；`~alice/...` 等指定用户的形式、环境变量与 shell 表达式保持不变。
- **规范化只读不改**——`canonicalizeWatchPath` 执行 `realpath` 探测并传播除路径不存在以外的错误；调用方仍负责目录创建、权限，以及对结果路径应用信任策略。
- **迁移显式且冲突安全，但非事务性**——`migrateLegacyRootToUser` 在完成一次冲突预检后逐个 rename 直接子项；并发写入任一目录的进程仍可能交错，因此请迁移处于静止状态的主目录，且无需重跑，因为预检会拒绝已存在的目标子项。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
