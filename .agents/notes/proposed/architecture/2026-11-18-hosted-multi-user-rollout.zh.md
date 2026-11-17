# Agent Note: 托管多用户上线与验证

Status: proposed

[English](2026-11-18-hosted-multi-user-rollout.md) | 中文

## 问题

前述四份记录各自改变单进程多用户部署的一层。它们单独使用时都无用，且各自都难以独立验证为"完成"：一个边界检查通过而持久化仍全局写入，会产生一个"当事人创建会话后它便消失"的部署；一个 realm 分区了存储而授权仍接纳任意 id，会产生一个"分区对它所服务的人不可见"的部署。

启动路径加剧了这一点。两个已发布的多进程启动器正是为此问题而存在，且被部署决策排除：`dsh route-users` 构造的一个 entry，其 `route-users` 插件占用 webserver fallback 席位（[`packages/host/route-users/src/index.ts`](../../../../packages/host/route-users/src/index.ts)），而 `client-connection` 把 `/api` 注册为具名前缀路由（[`packages/client/connection/src/index.ts:165`](../../../../packages/client/connection/src/index.ts)）。路由匹配按 exact、最长前缀、fallback 的顺序解析（[`packages/host/webserver/src/index.ts:651`](../../../../packages/host/webserver/src/index.ts)），因此 entry 自己应答 `/api`，代理永远看不到浏览器的 API 调用。同一代理把 `upgrade` 当逐跳头剥离，因此浏览器使用的 WebSocket 载体（[`packages/client/connection/src/client/index.ts:80`](../../../../packages/client/connection/src/client/index.ts)）永不跨越它。两个启动器都不在本部署的路径上，本记录把原因写下，以免下一位读者重新发现它。

缺的是让四项变更成为一个可用部署的组合，以及说明它有效的证据。

## 提案

一份组合、一个启动器，以及一套在任一层回归时失败的验证。

### 组合

托管 profile 就是已发布的 Web 组合，加四项变更：

1. 启用 `identity-feishu`，带上部署的 app id、secret 与 scopes。每个无会话的浏览器被重定向到 `/login`，且只有飞书交换完成后才被准入（[`packages/client/connection/src/rpc-host.ts:276`](../../../../packages/client/connection/src/rpc-host.ts) 的 `authorizeIndex`）。
2. 挂载用户 realm 注册表，其模板为[按用户 realm 分区](2026-11-18-per-user-realm-partitioning.zh.md) 的持久行。
3. `sandbox-policy` 解析调用者边界，并带[按用户执行约束](2026-11-18-per-user-execution-confinement.zh.md) 的 principal 钳制。
4. `user` 访问策略准入[按用户凭据与设置](2026-11-18-per-user-credentials-and-settings.zh.md) 的配置端点，其背后是[用户资源授权](2026-11-18-user-resource-authorization.zh.md) 的 owner 记录。

组合中其他一切不变：启动路径保持 `dsh --profile web` 加 `--patch` 覆盖层，因为部署需要一个进程与一个入口。既有的 `multi-user-feishu.yml` 覆盖层（[`apps/cli/config/examples/multi-user-feishu.yml`](../../../../apps/cli/config/examples/multi-user-feishu.yml)）是这件事的登录那一半，保持原样；本记录在其旁边加上分区那一半。

启动器仍留在树中，供确实选择进程隔离的部署使用。在此记录它们的 `/api` 与 WebSocket 限制，是关于"哪个模型不依赖它们"的陈述，而不是修复它们的计划。

### 首次运行状态

全新部署没有 `users/<key>` 树。首个已认证请求创建它，而创建不得竞争：来自一个人的两个并发请求必须产生一个 realm，两个人必须产生两个根。注册表的单飞保证是使其安全的东西，而验收标准用并发请求而非顺序请求来测试它。

从单用户组合升级的部署在 `<home>/sessions` 下会有会话。它们从任何 realm 都不可达。迁移是显式的运维操作，不是启动步骤：能归属的就归属，其余的留下，并说明无主会话需要运维来打开。

### 验证套件

证据必须是行为性的、在已发布端点上、带两个不同的已认证用户。四种既有测试形态覆盖它：

| 测试 | 它证明什么 |
|---|---|
| realm 分区，单元 | 两个 realm 持有不同的服务实例；`leakedServices` 一无所获 |
| 边界拒绝，单元 | [用户工作区根边界](2026-11-18-user-workspace-root-boundaries.zh.md)中的每条路径都拒绝；operator 不受影响 |
| 双用户隔离，host | A 的会话、工作区、附件与凭据通过每个 Remote 端点都从 B 不可达 |
| 无密钥录制会话快照 | 模型可见的策略文本陈述被钳制的模式与当事人自己的根 |

第三项是承重的一项。它必须通过真实 Gateway 与真实 Peer 运行，而不是手工构造的 Context，因为被测的保证是已认证请求与服务实例之间的路由，而手工 Context 可能把这层路由接错却仍然通过。

跨用户探针矩阵就是[按用户执行约束](2026-11-18-per-user-execution-confinement.zh.md) 中的工具表：对 `fs` 读、`fs` 写、`bash`、`terminal`、附件解析与 spill 取回各自而言，一个用户被拒绝触达另一人的树。没有探针的行就是一个缺口。

### 上线顺序

各层按"单独落地会破坏什么"排序。

1. **先边界。** 它们只做拒绝，因此停在这一步的部署更安全，且没有失去任何已有能力。
2. **其次分区。** 在它落地之前，托管部署的列表是空的；这是让部署可用而非收紧部署的变更。
3. **再次凭据与设置。** 它们依赖 realm 已存在。
4. **最后授权。** 它依赖 owner 字段，而那是带自己评审路径的持久化变更。

第 1 与第 2 步合起来是最小可用部署。只做 1、2 就停下的部署拥有正确的持久状态隔离与正确的工作区边界，配上当前的全局凭据文档——对一个受信任的小团体可用，对开放部署不可用。

## 备选方案

**修复 `route-users` 而非构建单进程路径。** 修复是可行的：把代理注册在 `/api` 前缀与 `remote.mux` upgrade 路由上而非 fallback，并把 upgrade 作为原始套接字隧道转发。它产生进程级隔离，强于 realm。已拒绝，因为部署决策是一个进程一个端口，且该修复还必须阻止 entry 自己的 `client-connection` 抢先占用 `/api`，这意味着把登录与传输拆分——对一个部署并不想要的模型而言，这比本提案更大。

**把各层作为一次变更提交。** 一个分支、一次评审、一次上线——协调更简单。它让失败模式无法区分：realm 缺陷与授权缺陷都表现为"用户什么都看不到"，而在同一 diff 中对持久化变更与策略变更做二分正是有序上线要避免的。因此拒绝，代价是中间状态可修订。

**仅依赖录制会话快照。** 快照钉住模型可见文本，那是策略提示的正确证据。它重放录制的日志，无法创建两个已认证身份，因此无法观察跨用户拒绝。它补充双用户 host 测试；它不能替代它。

## 验收标准

- 全新部署准入两个飞书身份并产生两个独立的用户根。
- 同一身份的并发首个请求产生一个 realm，而非两个。
- 四层各有一项在移除该层时失败的测试，且每项测试在已发布端点而非通过辅助函数运行。
- 双用户探针矩阵拒绝每条跨用户路径，且矩阵每个工具一行。
- 单用户部署（未注册身份 provider）行为字节一致，包括 launch token 回环。
- 从单用户 home 升级的路径连同其显式迁移被记录，且不运行任何自动启动迁移。
- `pnpm run build:check` 与 `pnpm run doc-sync` 在新记录及其双语配对下通过。

## 风险

**中间状态可发布但不安全。** 只做第 1 步就停下的部署有边界检查与全局凭据文档；做了第 1 步却跳过第 4 步的部署有正确的存储隔离，以及一个可按会话 id 到达的授权缺口。顺序记录必须被读作门禁而非建议，且每一步的验收标准必须是闸住下一步的东西。

**单用户回归是安静的失败。** 这里每一层都以 `user` principal 为条件，因此风险在于当没有 principal 时某处解析改变了行为。标准中的字节一致要求是抓住它的东西，它需要一项"身份 provider 已挂载但未注册适配器"的测试，而那正是接缝视为单用户的组合。

**验证套件是最慢的部分，也是最容易被削弱的。** 在一个 Context 里跑两个身份的双用户 host 测试，证明的东西少于通过独立已认证会话跑它们的测试，而更廉价的版本正是能通过的那个。点名该要求——真实 Gateway、真实 Peer、不同凭据——是保持证据诚实的东西。

**快照必须随头部变更一起移动。** [用户资源授权](2026-11-18-user-resource-authorization.zh.md) 改变持久化会话头部，而仓库要求 TypeScript 与 Python SDK 的期望输出以及录制的会话快照在同一变更中移动。只落地头部而不带它们的上线会让自己的门禁失败，这是正确的结果，但必须被计划而不是被发现。
