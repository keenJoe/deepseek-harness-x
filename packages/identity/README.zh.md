---
description: "identity 包组：由遥测、反馈与 DeepSeek 提供方请求共享的每个 harness home 匿名 id、与 provider 无关的身份契约、OIDC/SSO 提供方注册表、由部署配置的 OpenID Connect 适配器，以及已登录用户 principal。"
kind: "package-group"
---

# identity/ — 共享身份

[English](README.md) | 中文

## 概述

identity 组为每个 harness home 提供一个匿名 id，该安装的遥测、反馈与 DeepSeek 请求会把它附加到各自的记录上，因此离开同一个 home 的所有内容都能被识别为来自同一套安装，而无需识别用户身份。`identity-protocol` 增加与 provider 无关的 OAuth 身份契约与规范 ACL 键编解码。`identity-providers` 增加托管登录解析的、由部署选择的 OIDC/SSO 适配器注册表。`identity-provider-oidc` 增加针对单个 issuer 的、由部署配置的 OpenID Connect 适配器。`user-principal` 增加托管连接层据此划分的、已登录 `user` principal 与带品牌的 `UserId`。`identity-provider-feishu` 增加针对单个应用的飞书开放平台适配器。本组有六个包；本页列出本组的组成，每个包 README 负责细节。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`anonymous-user-id`](anonymous-user-id/README.zh.md) | 让每个 harness home 拥有一个匿名 id，遥测、反馈与 DeepSeek 请求把它附加到记录上，使来自同一安装的记录无需识别用户即可被辨认 |
| [`identity-protocol`](identity-protocol/README.zh.md) | owner bundle 与 Relay 共用的、与 provider 无关的 OAuth 身份契约与规范 ACL 键编解码 |
| [`identity-providers`](identity-providers/README.zh.md) | 托管多用户登录解析的、由部署选择的 OIDC/SSO 身份适配器注册表 |
| [`identity-provider-oidc`](identity-provider-oidc/README.zh.md) | 由部署配置的 OpenID Connect 适配器，把一个 issuer 注册到 `ctx.identityProviders`，并用授权码换取经校验的 id_token |
| [`identity-provider-feishu`](identity-provider-feishu/README.zh.md) | 由部署配置的飞书开放平台适配器，用授权码换取用户访问令牌并解析出已登录用户 |
| [`user-principal`](user-principal/README.zh.md) | 已登录 `user` principal、带品牌的 `UserId` 分区键，以及各按用户存储据此解析的持久化根目录辅助函数 |

<a id="related-documentation"></a>
## 相关文档

- [身份子系统](../../docs/subsystems/identity.zh.md)——与提供方无关的身份契约和 `ctx.identityProviders` 注册表。
- [会话遥测子系统](../../docs/subsystems/session-telemetry.zh.md)——在导出中携带该 id 的遥测功能。
- [dsh-llm-deepseek](../llm/llm-deepseek/README.zh.md)——在请求中携带该 id 的 DeepSeek 提供方。
- [dsh-command-feedback](../feedback/command-feedback/README.zh.md)——在确认文本中点名该匿名安装的反馈命令。

<a id="dev-note"></a>
## 开发备注

无。
