/** Public page-bootstrap options shared by the Host and Client halves. */

import z from '@deepseek-ai/schemastery'

/** Onboarding options after schema defaults are applied. */
export interface Config {
  /** Offer the browser API-key step when no native shell owns credential onboarding. */
  credentialOnboarding: boolean
}

/** Validate Host configuration and its public page-bootstrap payload. */
export const Config: z<Partial<Config>, Config> = z.object({
  credentialOnboarding: z.boolean().default(true),
})

/** Page-global key carrying only the public onboarding options. */
export const ONBOARDING_CONFIG_GLOBAL = '__DSH_MODELS_ONBOARDING__'

/** Options the Host publishes under {@link ONBOARDING_CONFIG_GLOBAL} for the rendered page. */
export interface OnboardingPageConfig {
  /** Resolved {@link Config.credentialOnboarding}. */
  readonly credentialOnboarding: boolean
  /** Whether the index renders for a signed-in person of a hosted deployment. */
  readonly hosted: boolean
}

/**
 * Read the hosted-page flag from the published page options.
 * @param payload - value carried under {@link ONBOARDING_CONFIG_GLOBAL}, read as untrusted data.
 * @returns whether a hosted deployment authenticated the page; `false` for any other value.
 */
export function hostedPage(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && Reflect.get(payload, 'hosted') === true
}
