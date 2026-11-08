---
description: "从一个入口 URL 把每个已登录浏览器路由到其各自的 harness 后端。"
kind: "package-library"
---

# @deepseek-ai/dsh-route-users

[English](README.md) | 中文

## 概述

`dsh-route-users` 是托管多用户 Web 的身份感知反向代理。入口 Web 进程拥有登录路由，本插件拥有 webserver fallback：浏览器登录后，其未匹配的请求被转发到拥有其 harness home 的每用户后端。代理自身从不铸造身份 —— 它通过已挂载的 Connection 服务读取调用方，并把规范 `userId` 映射到后端端口。没有会话的请求返回 401，没有后端的用户返回 502。

## 目录

- [使用本包](#use-this-package)
- [配置](#config)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [模型体验](#model-experience)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已拥有 `webServer`、`connection` 与 identity-provider 注册表的入口 Web 组装中挂载它，并为每个规范用户键配一个端口：

```yaml
- id: route-users
  name: '@deepseek-ai/dsh-route-users'
  config:
    ports:
      'feishu:tenant-7:ou_42': 3080

```

键是规范 `userId`（`provider:tenant:subject`）。对 `/login` 及其它精确 connection 路由的请求仍在入口应答；其余请求经会话 cookie 放行后转发到匹配的后端。

<a id="config"></a>
## 配置

| Key | 默认值 | 含义 |
|---|---|---|
| `ports` | 必填 | 规范用户键到 loopback 端口的映射。用户没有条目时请求返回 502。 |

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 路由器只做 HTTP 流式转发，不重写绝对重定向或 WebSocket upgrade；需要这些的部署应让后端共用一个 authority。
- hop-by-hop 头会被剥离；后端必须把入口当作客户端 authority。

<a id="model-experience"></a>
## 模型体验

无。路由发生在 HTTP 表面，不会进入模型请求。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
