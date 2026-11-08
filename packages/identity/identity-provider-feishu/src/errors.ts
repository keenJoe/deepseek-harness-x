/**
 * Structured failures of the Feishu Open Platform identity provider.
 *
 * Every failure carries a stable `code` so logs and tests route on the failure class
 * without parsing `message`.
 * @module @deepseek-ai/dsh-identity-provider-feishu/src/errors
 */

/** The token endpoint could not be requested or read. */
export const TOKEN_REQUEST_FAILED = 'TOKEN_REQUEST_FAILED'

/** The token response reported a nonzero code or omitted the user access token. */
export const INVALID_TOKEN_RESPONSE = 'INVALID_TOKEN_RESPONSE'

/** The user-info endpoint could not be requested or read. */
export const USER_INFO_FAILED = 'USER_INFO_FAILED'

/** The user-info response reported a nonzero code or omitted an identity field. */
export const INVALID_USER_INFO = 'INVALID_USER_INFO'

/** Feishu provider failure whose `code` one of the exported failure constants names. */
export class FeishuProviderError extends Error {
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
 * Narrow an arbitrary thrown value to a {@link FeishuProviderError}.
 * @param value - the caught value, `unknown` in catch clauses.
 * @returns true only for real instances.
 */
export function isFeishuProviderError(value: unknown): value is FeishuProviderError {
  return value instanceof FeishuProviderError
}
