/**
 * Principal of one logged-in user, named by a provider-neutral identity triple.
 *
 * This package augments the merge-extensible `PrincipalMap` with the `user` kind. One
 * `UserPrincipal` carries the identity triple a deployment's identity adapter resolved, a display
 * name for attribution, and an optional presentation-only avatar URL. It carries no credential, so
 * the value is safe to persist in Session logs. The canonical partition key for one user is the
 * `UserId` returned by {@link userId}, which brands the {@link identityKeyOf} codec output.
 *
 * @module @deepseek-ai/dsh-user-principal
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { identityKeyOf, normalizeIdentity } from '@deepseek-ai/dsh-identity-protocol'
import type { IdentityActor, IdentityTriple } from '@deepseek-ai/dsh-identity-protocol'
import { dshHomePath, userHomePath } from '@deepseek-ai/dsh-home-paths'
import { principalOf, type Principal } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** One logged-in user, as a deployment's identity adapter resolved them. */
    'user': UserPrincipal
  }
}

/** One logged-in user identified by a provider-neutral identity triple. */
export interface UserPrincipal {
  readonly kind: 'user'
  /** Identity provider that owns the subject. */
  readonly providerId: string
  /** Provider tenant that contains the subject. */
  readonly tenantId: string
  /** Provider-scoped subject id. */
  readonly subjectId: string
  /** Display name for attribution, never an authority. */
  readonly displayName: string
  /** Provider-issued avatar URL, presentation only; absent when the provider issues none. */
  readonly avatarUrl?: string
}

/** Canonical partition key for one user: the branded {@link identityKeyOf} output. */
export type UserId = Branded<'UserId'>

/**
 * Build the principal one logged-in user's Peer speaks for.
 *
 * The identity is normalized first, so a provider that issues no tenant records the documented
 * placeholder, and the fields are copied one by one so a caller-supplied actor contributes only the
 * triple, the display name, and an optional avatar.
 * @param identity Provider-resolved identity the login exchange returned.
 * @returns The user principal, or undefined when the provider or subject id is empty.
 */
export function userPrincipal(identity: IdentityActor): UserPrincipal | undefined {
  const normalized = normalizeIdentity(identity)
  if (normalized === undefined) return undefined
  return {
    kind: 'user',
    providerId: normalized.providerId,
    tenantId: normalized.tenantId,
    subjectId: normalized.subjectId,
    displayName: normalized.displayName,
    ...(normalized.avatarUrl === undefined ? {} : { avatarUrl: normalized.avatarUrl }),
  }
}

/**
 * The logged-in user one principal names, when it names one.
 * @param principal Caller identity a Peer or a message source carries.
 * @returns The user principal, or undefined for every other kind.
 */
export function userOf(principal: Principal): UserPrincipal | undefined {
  return principal.kind === 'user' ? principal : undefined
}

/**
 * Whether one principal is the given identity.
 *
 * Users compare by their whole identity key: the same subject id issued by two providers, or in two
 * tenants, is two users.
 * @param principal User principal to compare.
 * @param identity Identity to compare with.
 * @returns True when the identity keys match.
 */
export function isUser(principal: UserPrincipal, identity: IdentityTriple): boolean {
  return identityKeyOf(principal) === identityKeyOf(identity)
}

/**
 * Canonical partition key for one user.
 * @param principal User principal whose key to render.
 * @returns The branded identity key, stable across copies of the same identity.
 */
export function userId(principal: UserPrincipal): UserId {
  return brandString<UserId>(identityKeyOf(principal))
}

/**
 * The logged-in caller of the current Remote invocation.
 *
 * Trusted in-process code and the operator principal resolve `undefined`, which keeps the
 * single-user home in place for every composition that registers no identity provider.
 * @param ctx - Context whose ambient invocation names the caller.
 * @returns the caller principal, or `undefined` for the operator and in-process code.
 */
export function callerOf(ctx: Context): UserPrincipal | undefined {
  const invocation = 'invocation' in ctx ? ctx.invocation : undefined
  const principal = principalOf(invocation)
  return principal === undefined ? undefined : userOf(principal)
}

/**
 * One logged-in person`s durable root, with optional trailing segments.
 * @param user - the logged-in caller.
 * @param segments - segments appended below the user home.
 * @returns the absolute per-user path.
 */
export function userRoot(user: UserPrincipal, ...segments: string[]): string {
  return userHomePath(String(userId(user)), ...segments)
}

/**
 * The operator`s durable root, with optional trailing segments.
 * @param segments - segments appended below the harness home.
 * @returns the absolute operator path.
 */
export function operatorRoot(...segments: string[]): string {
  return dshHomePath(...segments)
}

/**
 * Durable root for the caller of one Context, falling back to the operator home.
 * @param ctx - Context whose ambient invocation names the caller.
 * @param segments - segments appended below the resolved home.
 * @returns the absolute root this caller owns for those segments.
 */
export function callerRoot(ctx: Context, ...segments: string[]): string {
  const user = callerOf(ctx)
  return user === undefined ? operatorRoot(...segments) : userRoot(user, ...segments)
}

/**
 * Whether one absolute path sits inside a root, at a path-separator boundary.
 * @param path - absolute candidate path.
 * @param root - absolute root to test against.
 * @returns true when the path is the root or a descendant of it.
 */
export function isWithinRoot(path: string, root: string): boolean {
  const prefix = root.endsWith('/') ? root : root + '/'
  return path === root || path.startsWith(prefix)
}
