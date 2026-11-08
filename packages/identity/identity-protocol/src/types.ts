/** Provider, tenant, and subject triple that identifies one person across providers. */
export interface IdentityTriple {
  /** Identity provider that owns the subject. */
  readonly providerId: string
  /** Provider tenant that contains the subject. */
  readonly tenantId: string
  /** Provider-scoped subject id. */
  readonly subjectId: string
}

/** Provider-neutral viewer identity resolved by a Relay. */
export interface IdentityActor extends IdentityTriple {
  readonly displayName: string
  /**
   * Provider-issued avatar URL, when the provider publishes one. Presentation only: it carries no
   * credential, and a provider that issues none leaves it absent rather than inventing a value.
   */
  readonly avatarUrl?: string
}

/** Request facts needed to build one provider authorization redirect. */
export interface IdentityAuthorizationRequest {
  /** State value the login flow minted; the provider echoes it back unchanged. */
  readonly state: string
  /** Callback URL the provider must redirect to after authorization. */
  readonly redirectUri: string
  /** Scopes the login flow requests. */
  readonly scopes: readonly string[]
  /** Hint for selecting one login identity; absent for a provider that needs none. */
  readonly loginHint?: string
  /** PKCE S256 code challenge the provider redirect includes; absent for a provider that uses no PKCE. */
  readonly codeChallenge?: string
  /** PKCE challenge method, always S256 when a code challenge is present. */
  readonly codeChallengeMethod?: 'S256'
}

/** Request facts needed to exchange a provider callback code. */
export interface IdentityExchangeRequest {
  /** Authorization code the provider issued at its callback. */
  readonly code: string
  /** State value the login flow minted and the provider echoed back unchanged. */
  readonly state: string
  /** Callback URL the exchange repeats to the provider. */
  readonly redirectUri: string
  /** PKCE S256 code verifier the login flow minted; absent for a provider that uses no PKCE. */
  readonly codeVerifier?: string
}

/** Generic browser OAuth contract a deployment's identity adapter implements; the protocol's mock implements it for local runs. */
export interface IdentityProvider {
  readonly id: string
  readonly scopes: readonly string[]
  authorizationUrl(request: IdentityAuthorizationRequest): URL
  exchange(request: IdentityExchangeRequest): Promise<IdentityActor>
}
