/**
 * Feishu Open Platform identity provider.
 *
 * One plugin instance registers one adapter on `ctx.identityProviders`. A browser login goes to
 * the Feishu authorization page, and the returned code is exchanged for a `user_access_token` at
 * the token endpoint; that token then reads the signed-in person from the user-info endpoint. The
 * resolved `IdentityActor` carries the Feishu `open_id` as the subject and the tenant key as the
 * tenant, so the canonical partition key is stable for one app and one tenant.
 *
 * Feishu issues no `id_token` and no JWKS, so this adapter performs no local signature check: the
 * authority is the HTTPS token endpoint authenticated by `app_secret`. Endpoints derive from a
 * configurable base URL, which also selects Lark (international) with its own base.
 * @module @deepseek-ai/dsh-identity-provider-feishu
 */

import { type Context, type Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  requireIdentityTenant,
  type IdentityActor,
  type IdentityAuthorizationRequest,
  type IdentityExchangeRequest,
  type IdentityProvider,
} from '@deepseek-ai/dsh-identity-protocol'
import type {} from '@deepseek-ai/dsh-identity-providers'
import {
  FeishuProviderError,
  INVALID_TOKEN_RESPONSE,
  INVALID_USER_INFO,
  TOKEN_REQUEST_FAILED,
  USER_INFO_FAILED,
} from './errors.ts'
import { isRecord, stringField } from './json.ts'

export * from './errors.ts'

/** Base URL of the Feishu Open Platform API; a trailing slash is normalized. */
export const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis/'

/** Scope that permits reading the signed-in person basic profile. */
export const FEISHU_USER_READ_SCOPE = 'contact:user.base:readonly'

/** Deployment choices for one Feishu Open Platform provider. */
export interface Config {
  /** Registry id, also the `providerId` every resolved identity carries. */
  readonly id: string
  /** Feishu Open Platform app id (`app_id`). */
  readonly appId: string
  /** Feishu app secret, read per exchange so a rotation applies without a reload. */
  readonly appSecret: Volatile<string | undefined>
  /** Scopes the login requests; the app must be granted these. */
  readonly scopes: readonly string[]
  /** Feishu or Lark API base; a Lark deployment supplies its own host. */
  readonly baseUrl: string
  /** Deadline for each token and user-info request, in milliseconds. */
  readonly requestTimeoutMs: number
  /** Tenant id used when the user-info response carries no tenant key. */
  readonly defaultTenant?: string | undefined
}

/**
 * Validate an absolute Feishu/Lark base URL.
 * @param value - configured base URL.
 * @returns the value with one trailing slash.
 */
function baseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new Error('feishu baseUrl must be an absolute URL', { cause: error })
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('feishu baseUrl must be an HTTP(S) URL without credentials or a fragment')
  }
  return url.href.endsWith('/') ? url.href : url.href + '/'
}

/** Validated deployment choices; a deployment with no app id or secret fails at load. */
export const Config = Schema.object({
  id: Schema.string().min(1).required(),
  appId: Schema.string().min(1).required(),
  appSecret: Schema.string().min(1).role('secret').volatile(),
  scopes: Schema.array(Schema.string().min(1)).default([FEISHU_USER_READ_SCOPE]),
  baseUrl: Schema.transform(Schema.string().min(1), baseUrl).default(FEISHU_BASE_URL),
  requestTimeoutMs: Schema.natural().min(1).max(120_000).default(30_000),
  defaultTenant: Schema.string().min(1),
})

/** Registers one Feishu Open Platform adapter on the identity-provider registry. */
export default class FeishuIdentityProvider {
  static inject = ['identityProviders']
  static Config = Config

  /**
   * @param ctx - plugin context; the adapter is registered through its effect scope so unloading withdraws it.
   * @param config - validated deployment choices.
   */
  constructor(ctx: Context, private readonly config: Config) {
    const adapter: IdentityProvider = {
      id: config.id,
      scopes: config.scopes,
      authorizationUrl: request => this.authorizationUrl(request),
      exchange: request => this.exchange(request),
    }
    ctx.effect(() => ctx.identityProviders.register(config.id, adapter))
  }

  private authorizationUrl(request: IdentityAuthorizationRequest): URL {
    const url = new URL('authen/v1/authorize', this.config.baseUrl)
    url.searchParams.set('app_id', this.config.appId)
    url.searchParams.set('redirect_uri', request.redirectUri)
    url.searchParams.set('state', request.state)
    return url
  }

  private async exchange(request: IdentityExchangeRequest): Promise<IdentityActor> {
    const token = await this.requestUserAccessToken(request)
    const profile = await this.requestUserInfo(token)
    const openId = stringField(profile, 'open_id')
    if (openId === undefined) {
      throw new FeishuProviderError(
        'Feishu provider ' + JSON.stringify(this.config.id) + ' user-info response omitted open_id',
        INVALID_USER_INFO,
      )
    }
    const tenantId = stringField(profile, 'tenant_key') ?? this.config.defaultTenant
    const name = stringField(profile, 'name')
    const avatarUrl = stringField(profile, 'avatar_url')
    const identity = requireIdentityTenant({
      providerId: this.config.id,
      tenantId: tenantId ?? '',
      subjectId: openId,
      displayName: name ?? openId,
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
    })
    if (identity === undefined) {
      throw new FeishuProviderError(
        'Feishu provider ' + JSON.stringify(this.config.id) + ' resolved no tenant id; configure defaultTenant',
        INVALID_USER_INFO,
      )
    }
    return identity
  }

  private async requestUserAccessToken(request: IdentityExchangeRequest): Promise<string> {
    const appSecret = this.config.appSecret.get()
    if (appSecret === undefined) {
      throw new FeishuProviderError(
        'Feishu provider ' + JSON.stringify(this.config.id) + ' has no app secret; configure appSecret',
        TOKEN_REQUEST_FAILED,
      )
    }
    const body = {
      grant_type: 'authorization_code',
      client_id: this.config.appId,
      client_secret: appSecret,
      code: request.code,
      redirect_uri: request.redirectUri,
    }
    const response = await this.requestJson(
      new URL('authen/v2/oauth/token', this.config.baseUrl),
      { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) },
      TOKEN_REQUEST_FAILED,
    )
    const code = this.dataCode(response)
    if (code !== 0) {
      throw new FeishuProviderError(
        'Feishu provider ' + JSON.stringify(this.config.id) + ' token endpoint reported code ' + String(code) + ': ' + (stringField(response, 'msg') ?? 'no message'),
        INVALID_TOKEN_RESPONSE,
      )
    }
    const data = this.dataObject(response)
    const token = stringField(data, 'access_token')
    if (token === undefined) {
      throw new FeishuProviderError(
        'Feishu provider ' + JSON.stringify(this.config.id) + ' token response omitted access_token',
        INVALID_TOKEN_RESPONSE,
      )
    }
    return token
  }

  private async requestUserInfo(accessToken: string): Promise<Record<string, unknown>> {
    const response = await this.requestJson(
      new URL('authen/v1/user_info', this.config.baseUrl),
      { headers: { authorization: 'Bearer ' + accessToken, accept: 'application/json' } },
      USER_INFO_FAILED,
    )
    const code = this.dataCode(response)
    if (code !== 0) {
      throw new FeishuProviderError(
        'Feishu provider ' + JSON.stringify(this.config.id) + ' user-info endpoint reported code ' + String(code) + ': ' + (stringField(response, 'msg') ?? 'no message'),
        INVALID_USER_INFO,
      )
    }
    return this.dataObject(response)
  }

  /** Read the Feishu envelope `code`; a missing numeric code is treated as a transport failure. */
  private dataCode(response: Record<string, unknown>): number {
    const code = response.code
    return typeof code === 'number' ? code : -1
  }

  /** Read the Feishu envelope `data` object, required for every successful response. */
  private dataObject(response: Record<string, unknown>): Record<string, unknown> {
    const data = response.data
    return isRecord(data) ? data : {}
  }

  private async requestJson(url: URL, init: RequestInit, failureCode: string): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(this.config.requestTimeoutMs) })
    } catch (error) {
      throw new FeishuProviderError('request to ' + url.href + ' failed', failureCode, { cause: error })
    }
    if (!response.ok) {
      throw new FeishuProviderError('request to ' + url.href + ' failed with HTTP ' + String(response.status), failureCode)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new FeishuProviderError('response from ' + url.href + ' is not JSON', failureCode, { cause: error })
    }
    if (!isRecord(payload)) {
      throw new FeishuProviderError('response from ' + url.href + ' is not a JSON object', failureCode)
    }
    return payload
  }
}
