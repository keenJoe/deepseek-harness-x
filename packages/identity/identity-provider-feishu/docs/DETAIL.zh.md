# 飞书开放平台登录

`identity-provider-feishu` 在 `ctx.identityProviders` 上注册一个飞书开放平台适配器。浏览器在飞书完成授权，返回的 code 被换取 `user_access_token`，再用该 token 从用户信息端点读取当前用户。解析出的身份以飞书 `open_id` 为 subject、以租户 key 为 tenant。

飞书不返回 `id_token` 也没有 JWKS，因此没有本地签名校验；以 `app_secret` 认证的 HTTPS token 端点就是权威来源。
