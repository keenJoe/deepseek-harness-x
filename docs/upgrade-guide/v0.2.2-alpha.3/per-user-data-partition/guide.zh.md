---
kind: upgrade-guide
description: "会话列表、精确读取与 workspace 操作被限制在调用用户范围内，并新增一次性显式迁移把旧 owner 数据移动到 users/<userKey> 下。"
---

# 按用户数据分区

[English](guide.md) | 中文

## 变更

托管多用户 profile 把每个已登录用户的持久化数据分区到 `<DSH_HOME>/users/<userKey>` 下，其中 `userKey` 是来自 identity 包的规范百分号编码身份三元组。携带 `user` principal 的 Remote 调用现在只读取和修改该用户自己的条目。`sessionQuery.listSessions`、`filterSessions` 与精确会话读取被限制在物化位置位于调用方 `users/<userKey>` 根目录下的持久化会话内，并丢弃 live 会话。`workspaceRegistry.list` 及其修改操作——`get`、`resolveByPath`、`delete`、`insertBefore`、`create`、`createCanonical`、归档、置顶及其 getter——被限制在打上该用户 key 的 workspace 内，`create`/`createCanonical` 在新记录上打上 `owner`。owner principal 与受信任的进程内代码保持不变，拥有完整的全局语料库与注册表。部署多个已登录用户的宿主，以及列出或修改会话或 workspace 的 SDK/wire 客户端会受到影响。

## 迁移

1. 停止 harness，然后为每个用户执行一次显式迁移：用 `resolveDshHome()` 解析 harness 主目录，用 `userHomePath(userKey)` 解析用户根目录，再调用 `migrateLegacyRootToUser(resolveDshHome(), userRoot)`。它把旧主目录的每个直接子项重命名到按用户根目录，并在任一目标子项已存在或目录缺失时于改动任何内容之前拒绝，因此旧主目录在失败时保持完整。不要每次启动都运行它。
2. 确认每个持久化根目录已移动：`sessions`、`storages`、`attachments` 与设置文件现在应位于 `users/<userKey>` 下，旧主目录保留原地但为空。
3. 在会话持久化与存储后端中按用户分区并路由写入，因为本版本中的注册表层作用域只读取按用户位置，并不会重新路由后端写入。
4. 重新构建宿主与客户端，确认 `user` 只看到自己的会话与 workspace，而 owner 仍能看到全部记录。
