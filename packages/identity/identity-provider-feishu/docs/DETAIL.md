# Feishu Open Platform sign-in

`identity-provider-feishu` registers one Feishu Open Platform adapter on `ctx.identityProviders`. The browser authorizes at Feishu, the returned code is exchanged for a `user_access_token`, and that token reads the person from the user-info endpoint. The resolved identity carries the Feishu `open_id` as its subject and the tenant key as its tenant.

Feishu issues no `id_token` and no JWKS, so there is no local signature check; the HTTPS token endpoint authenticated with `app_secret` is the authority.
