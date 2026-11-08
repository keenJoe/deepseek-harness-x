/**
 * Provider-neutral OAuth identity contract shared by the owner bundle and the Relay.
 *
 * This package owns the identity triple that names one person, the browser OAuth
 * authorization/exchange interface a deployment's identity adapter implements, and the
 * canonical ACL key codec every adapter applies before an identity is stored. It owns no
 * credential storage, HTTP client, or runtime state, so both consumers share one copy.
 *
 * @module @deepseek-ai/dsh-identity-protocol
 */

export * from './types.ts'
export * from './keys.ts'
