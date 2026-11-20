/** Host Loader entry declaring the Models credential-onboarding choice; onboarding belongs to the Client. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { userOf } from '@deepseek-ai/dsh-user-principal'
import { ONBOARDING_CONFIG_GLOBAL, type OnboardingPageConfig } from './onboarding-config.ts'
import type { ModelsConfig } from './types.ts'

/** Credential-onboarding choice synced to the browser. */
export type Config = ModelsConfig

/** Credential-onboarding choice synced to the browser. */
export const Config = z.object({
  credentialOnboarding: z.boolean().default(true).volatile(),
})

/**
 * Publish the page-bootstrap options the Client reads before its first render.
 * The Loader validates this entry's Config; the browser face receives its
 * volatile fields, and the rendered page also learns whether it speaks for a
 * signed-in person of a hosted deployment.
 * @param ctx - Host context carrying the webServer event.
 * @param config - validated Config.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table, peer) => {
    const value: OnboardingPageConfig = {
      credentialOnboarding: config.credentialOnboarding.get(),
      hosted: userOf(peer.principal) !== undefined,
    }
    table.push({ kind: 'global', name: ONBOARDING_CONFIG_GLOBAL, value })
  })
}
