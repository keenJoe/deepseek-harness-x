`identity-provider-oidc` 行默认关闭：OpenID Connect provider 缺少部署事实就无法工作。在加载它的 profile patch 中启用该行，并填入 `issuer`、`clientId` 及其余配置。配置的 `id` 同时是 `?provider=` 的取值、身份提供方注册表里的键，以及每个已解析身份上记录的 `providerId`。

浏览器登录从 `/login?provider=<id>` 开始。Web 连接生成一次性 `state` 与 PKCE S256 code challenge，把浏览器重定向到 issuer 的授权端点，issuer 再重定向回 `/login/callback`；随后连接消费该 `state`，并用匹配的 code verifier 请求 provider 兑换返回的 code。只注册了一个 provider 的部署，裸 `/login` 会直接选择它。

兑换时在 token 端点重复 `redirect_uri` 与 `code_verifier`，仅在设置了 `clientSecret` 时使用 HTTP Basic 认证。如果没有同时配置 `authorizationEndpoint`、`tokenEndpoint` 和 `jwksUri`，端点取自 `<issuer>/.well-known/openid-configuration`，并在插件加载时读取：issuer 不可达，或发现文档的 `issuer` 与配置值不一致，都会让加载失败而不是等到首次登录。

返回的 `id_token` 在 harness 进程内校验，而不是调用远端 introspection：用 `node:crypto` 以 issuer 的 JWKS 公钥验证其 RS256 签名，并要求 `iss`、`aud`、`exp`、`sub` 声明全部成立。只有这些检查通过后登录才会解析出身份，未经验证或已过期的 token 永远不会接入会话。

tenant 优先取 `tenantClaim` 指定的声明；token 没有该声明时取 `defaultTenant`。两者都无法确定 tenant 时，登录被拒绝，而不是猜测一个 tenant。
