/**
 * Structured failures of the OpenID Connect identity provider.
 *
 * Every failure carries a stable `code` so logs and tests can route on the failure
 * class without parsing `message`.
 *
 * @module @deepseek-ai/dsh-identity-provider-oidc/src/errors
 */

/** The issuer discovery document could not be requested or read. */
export const DISCOVERY_FAILED = 'DISCOVERY_FAILED'

/** The discovery document is malformed or declares a different issuer. */
export const INVALID_DISCOVERY = 'INVALID_DISCOVERY'

/** The token endpoint refused the code exchange or answered unreadably. */
export const TOKEN_REQUEST_FAILED = 'TOKEN_REQUEST_FAILED'

/** The JWKS document could not be requested, read, or contained no usable key. */
export const JWKS_FAILED = 'JWKS_FAILED'

/** The id_token failed signature or claim validation. */
export const INVALID_ID_TOKEN = 'INVALID_ID_TOKEN'

/**
 * OIDC provider failure with a stable `code` one of the exported failure constants names.
 */
export class OidcProviderError extends Error {
  /** Stable machine-routable failure class. */
  readonly code: string

  /**
   * @param message - human-readable report naming the failing step and value.
   * @param code - one of the exported failure constants.
   * @param options - standard error options; the transport failure is passed as `cause`.
   */
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

/**
 * Narrow an arbitrary thrown value to an {@link OidcProviderError}.
 * @param value - the caught value, `unknown` in catch clauses.
 * @returns true only for real instances; duck-typed or cross-realm errors do not narrow.
 */
export function isOidcProviderError(value: unknown): value is OidcProviderError {
  return value instanceof OidcProviderError
}
