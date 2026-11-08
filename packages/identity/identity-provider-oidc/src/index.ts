/**
 * Deployment-configured OpenID Connect identity provider.
 *
 * One plugin instance registers one adapter on `ctx.identityProviders`. A browser
 * login reaches the issuer's authorization endpoint through
 * `IdentityProvider.authorizationUrl`, and the returned code is exchanged at the
 * token endpoint for an `id_token` that is verified locally with `node:crypto`
 * before it becomes an `IdentityActor`.
 *
 * Endpoints come either from the three static endpoint fields or from the issuer's
 * `<issuer>/.well-known/openid-configuration` document, which is resolved during
 * plugin init so a deployment that cannot reach its issuer fails at load instead of
 * at the first login.
 *
 * @module @deepseek-ai/dsh-identity-provider-oidc
 */

import { Buffer } from 'node:buffer'
import { Service, type Context, type Volatile } from '@deepseek-ai/cordis'
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
  DISCOVERY_FAILED,
  INVALID_DISCOVERY,
  INVALID_ID_TOKEN,
  JWKS_FAILED,
  OidcProviderError,
  TOKEN_REQUEST_FAILED,
} from './errors.ts'
import { isRecord, stringField } from './json.ts'
import { validateIdTokenClaims, verifyIdTokenSignature, type RsaJwk } from './id-token.ts'

export * from './errors.ts'

/** Discovery path appended to the configured issuer. */
const DISCOVERY_SUFFIX = '.well-known/openid-configuration'

/**
 * Deployment choices for one OpenID Connect provider.
 */
export interface Config {
  /** Registry id, also the `providerId` every resolved identity carries. */
  readonly id: string
  /** Expected `iss` claim and the base of the discovery document. */
  readonly issuer: string
  /** OAuth client id. */
  readonly clientId: string
  /**
   * OAuth client secret. When set, the token request authenticates with HTTP Basic, read per
   * exchange so a rotated value applies without a reload.
   */
  readonly clientSecret: Volatile<string | undefined>
  /** Scopes the login requests. */
  readonly scopes: readonly string[]
  /** Authorization endpoint; configured together with {@link Config.tokenEndpoint} and {@link Config.jwksUri}. */
  readonly authorizationEndpoint?: string | undefined
  /** Token endpoint; configured together with the other two static endpoints. */
  readonly tokenEndpoint?: string | undefined
  /** JWKS URI; configured together with the other two static endpoints. */
  readonly jwksUri?: string | undefined
  /** Deadline for each issuer, JWKS, and token request, in milliseconds. */
  readonly requestTimeoutMs: number
  /** Tenant id used when the token carries no configured tenant claim. */
  readonly defaultTenant?: string | undefined
  /** id_token claim naming the tenant. */
  readonly tenantClaim?: string | undefined
}

function httpUrl(field: string): (value: string) => string {
  return (value) => {
    let url: URL
    try {
      url = new URL(value)
    } catch (error) {
      throw new Error('OIDC ' + field + ' must be an absolute URL', { cause: error })
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hash !== '') {
      throw new Error('OIDC ' + field + ' must be an HTTP(S) URL without credentials or a fragment')
    }
    return value
  }
}

/**
 * Validated deployment choices; a deployment that cannot reach its issuer fails at load.
 */
export const Config = Schema.object({
  id: Schema.string().min(1).required(),
  issuer: Schema.transform(Schema.string().min(1), httpUrl('issuer')).required(),
  clientId: Schema.string().min(1).required(),
  clientSecret: Schema.string().min(1).role('secret').volatile(),
  scopes: Schema.array(Schema.string().min(1)).default(['openid', 'profile', 'email']),
  authorizationEndpoint: Schema.transform(Schema.string().min(1), httpUrl('authorizationEndpoint')),
  tokenEndpoint: Schema.transform(Schema.string().min(1), httpUrl('tokenEndpoint')),
  jwksUri: Schema.transform(Schema.string().min(1), httpUrl('jwksUri')),
  requestTimeoutMs: Schema.natural().min(1).max(120_000).default(30_000),
  defaultTenant: Schema.string().min(1),
  tenantClaim: Schema.string().min(1),
})

/** Endpoints one redirect and one exchange use. */
interface Endpoints {
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly jwksUri: string
}

/**
 * Registers one OpenID Connect adapter on the identity-provider registry.
 */
export default class OidcIdentityProvider {
  static inject = ['identityProviders']
  static Config = Config

  private readonly staticEndpoints: Endpoints | undefined
  private resolvedEndpoints: Endpoints | undefined
  private cachedKeys: readonly RsaJwk[] | undefined

  /**
   * @param ctx - plugin context; the adapter is registered through its effect scope so unloading withdraws it.
   * @param config - validated deployment choices.
   */
  constructor(ctx: Context, private readonly config: Config) {
    const { authorizationEndpoint, tokenEndpoint, jwksUri } = config
    if (authorizationEndpoint !== undefined && tokenEndpoint !== undefined && jwksUri !== undefined) {
      this.staticEndpoints = { authorizationEndpoint, tokenEndpoint, jwksUri }
    } else if (authorizationEndpoint !== undefined || tokenEndpoint !== undefined || jwksUri !== undefined) {
      throw new OidcProviderError(
        'OIDC provider ' + JSON.stringify(config.id) + ': authorizationEndpoint, tokenEndpoint, and jwksUri must be configured together',
        INVALID_DISCOVERY,
      )
    } else {
      this.staticEndpoints = undefined
    }
    const adapter: IdentityProvider = {
      id: config.id,
      scopes: config.scopes,
      authorizationUrl: request => this.authorizationUrl(request),
      exchange: request => this.exchange(request),
    }
    ctx.effect(() => ctx.identityProviders.register(config.id, adapter))
  }

  /**
   * Resolve the discovery document when the deployment configured no static endpoints.
   * @returns resolution after the endpoints are cached, or immediately for static configuration.
   * @throws {OidcProviderError} code `DISCOVERY_FAILED` or `INVALID_DISCOVERY` when the issuer cannot be read.
   */
  async [Service.init](): Promise<void> {
    if (this.staticEndpoints !== undefined) return
    this.resolvedEndpoints = await this.discover()
  }

  private endpoints(): Endpoints {
    if (this.staticEndpoints !== undefined) return this.staticEndpoints
    if (this.resolvedEndpoints !== undefined) return this.resolvedEndpoints
    throw new OidcProviderError(
      'OIDC provider ' + JSON.stringify(this.config.id) + ' resolved no endpoints',
      DISCOVERY_FAILED,
    )
  }

  private authorizationUrl(request: IdentityAuthorizationRequest): URL {
    const url = new URL(this.endpoints().authorizationEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('scope', request.scopes.join(' '))
    url.searchParams.set('state', request.state)
    url.searchParams.set('redirect_uri', request.redirectUri)
    if (request.codeChallenge !== undefined) {
      url.searchParams.set('code_challenge', request.codeChallenge)
      url.searchParams.set('code_challenge_method', request.codeChallengeMethod ?? 'S256')
    }
    if (request.loginHint !== undefined) {
      url.searchParams.set('login_hint', request.loginHint)
    }
    return url
  }

  private async exchange(request: IdentityExchangeRequest): Promise<IdentityActor> {
    const endpoints = this.endpoints()
    const idToken = await this.requestIdToken(endpoints.tokenEndpoint, request)
    const keys = await this.keys(endpoints.jwksUri)
    const { claims, tenantId } = validateIdTokenClaims(verifyIdTokenSignature(idToken, keys), {
      issuer: this.config.issuer,
      clientId: this.config.clientId,
      now: Date.now(),
      ...(this.config.tenantClaim === undefined ? {} : { tenantClaim: this.config.tenantClaim }),
    })
    const identity = requireIdentityTenant({
      providerId: this.config.id,
      tenantId: tenantId ?? this.config.defaultTenant ?? '',
      subjectId: claims.sub,
      displayName: claims.name ?? claims.preferredUsername ?? claims.sub,
      ...(claims.picture === undefined ? {} : { avatarUrl: claims.picture }),
    })
    if (identity === undefined) {
      throw new OidcProviderError(
        'OIDC provider ' + JSON.stringify(this.config.id) + ' resolved no tenant id; configure tenantClaim or defaultTenant',
        INVALID_ID_TOKEN,
      )
    }
    return identity
  }

  private async requestIdToken(endpoint: string, request: IdentityExchangeRequest): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: request.code,
      redirect_uri: request.redirectUri,
      client_id: this.config.clientId,
    })
    if (request.codeVerifier !== undefined) body.set('code_verifier', request.codeVerifier)
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    }
    const clientSecret = this.config.clientSecret.get()
    if (clientSecret !== undefined) {
      headers.authorization = 'Basic ' + Buffer.from(this.config.clientId + ':' + clientSecret).toString('base64')
    }
    const response = await this.requestJson(endpoint, { method: 'POST', headers, body: body.toString() }, TOKEN_REQUEST_FAILED)
    const idToken = stringField(response, 'id_token')
    if (idToken === undefined) {
      throw new OidcProviderError(
        'OIDC provider ' + JSON.stringify(this.config.id) + ' token endpoint returned no id_token',
        TOKEN_REQUEST_FAILED,
      )
    }
    return idToken
  }

  private async keys(endpoint: string): Promise<readonly RsaJwk[]> {
    if (this.cachedKeys !== undefined) return this.cachedKeys
    const document = await this.requestJson(endpoint, { headers: { accept: 'application/json' } }, JWKS_FAILED)
    const published = document.keys
    if (!Array.isArray(published)) {
      throw new OidcProviderError('JWKS document ' + endpoint + ' carries no keys array', JWKS_FAILED)
    }
    const keys = published.filter((key): key is RsaJwk => isRecord(key) && typeof key.kty === 'string')
    if (keys.length === 0) {
      throw new OidcProviderError('JWKS document ' + endpoint + ' publishes no usable key', JWKS_FAILED)
    }
    this.cachedKeys = keys
    return keys
  }

  private async discover(): Promise<Endpoints> {
    const url = this.discoveryUrl()
    const document = await this.requestJson(url, { headers: { accept: 'application/json' } }, DISCOVERY_FAILED)
    const issuer = stringField(document, 'issuer')
    if (issuer !== this.config.issuer) {
      throw new OidcProviderError(
        'discovery document ' + url + ' declares issuer ' + JSON.stringify(issuer ?? '') + ', not the configured ' + JSON.stringify(this.config.issuer),
        INVALID_DISCOVERY,
      )
    }
    const authorizationEndpoint = stringField(document, 'authorization_endpoint')
    const tokenEndpoint = stringField(document, 'token_endpoint')
    const jwksUri = stringField(document, 'jwks_uri')
    if (authorizationEndpoint === undefined || tokenEndpoint === undefined || jwksUri === undefined) {
      throw new OidcProviderError(
        'discovery document ' + url + ' omits authorization_endpoint, token_endpoint, or jwks_uri',
        INVALID_DISCOVERY,
      )
    }
    return { authorizationEndpoint, tokenEndpoint, jwksUri }
  }

  private discoveryUrl(): string {
    const base = this.config.issuer.endsWith('/') ? this.config.issuer : this.config.issuer + '/'
    return new URL(DISCOVERY_SUFFIX, base).href
  }

  private async requestJson(url: string, init: RequestInit, failureCode: string): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(this.config.requestTimeoutMs) })
    } catch (error) {
      throw new OidcProviderError('request to ' + url + ' failed', failureCode, { cause: error })
    }
    if (!response.ok) {
      throw new OidcProviderError('request to ' + url + ' failed with HTTP ' + String(response.status), failureCode)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new OidcProviderError('response from ' + url + ' is not JSON', failureCode, { cause: error })
    }
    if (!isRecord(payload)) {
      throw new OidcProviderError('response from ' + url + ' is not a JSON object', failureCode)
    }
    return payload
  }
}
