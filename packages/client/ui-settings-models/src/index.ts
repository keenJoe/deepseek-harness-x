/** Host configuration and page bootstrap for Models credential onboarding. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { userOf } from '@deepseek-ai/dsh-user-principal'
import { type Config, ONBOARDING_CONFIG_GLOBAL, type OnboardingPageConfig } from './onboarding-config.ts'

export { Config } from './onboarding-config.ts'

/**
 * Publish the credential-onboarding choice before browser plugins activate.
 * @param ctx - Host context collecting the page's initialization data.
 * @param config - plugin options with schema defaults applied by the Loader.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table, peer) => {
    const value: OnboardingPageConfig = {
      credentialOnboarding: config.credentialOnboarding,
      hosted: userOf(peer.principal) !== undefined,
    }
    table.push({ kind: 'global', name: ONBOARDING_CONFIG_GLOBAL, value })
  })
}
