/**
 * Durable browser-session records for the Host Connection carrier.
 *
 * One record pairs a logged-in person's {@link UserPrincipal} with the signed
 * cookie's session id, so `HostConnectionService.admit` resolves a cookie to a
 * live user Peer and logout revokes the record. The full principal is stored
 * (not just its key) so a re-admitted Peer reconstructs the same display name
 * and avatar without a second IdP round-trip. The record carries no credential:
 * the cookie signature still proves possession, and the stored principal is
 * safe to read back.
 *
 * @module @deepseek-ai/dsh-client-connection/src/storage
 */

import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { DomainTableSpec } from '@deepseek-ai/dsh-storage-domain'
import type { UserPrincipal } from '@deepseek-ai/dsh-user-principal'

/** Opaque browser-session identity minted once per login. */
export type BrowserSessionId = Branded<'BrowserSessionId'>

/** Durable form of a logged-in person's principal; branding is compile-time only. */
const userPrincipalSchema = z.object({
  kind: z.literal('user'),
  providerId: z.string().min(1),
  tenantId: z.string().min(1),
  subjectId: z.string().min(1),
  displayName: z.string(),
  avatarUrl: z.string().exactOptional(),
}).strict()

/** Non-empty session id, branded at the durable boundary. */
const browserSessionIdSchema = z.string().min(1).transform(value => value as BrowserSessionId)

/** One signed-in person's browser session record. */
export const browserSessionRecordSchema = z.object({
  /** The same id the table is keyed by; denormalized so a scan does not track keys. */
  sessionId: browserSessionIdSchema,
  /** The whole principal, so re-admission reconstructs attribution without an IdP round-trip. */
  user: userPrincipalSchema,
  /** Canonical partition key (the branded `userId` output), denormalized for scoped lookups. */
  userKey: z.string().min(1),
  /** Provider that resolved this identity; equals `user.providerId`. */
  providerId: z.string().min(1),
  /** Millisecond epoch instants; the cookie carries the same values. */
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  /** OAuth state value the callback exchanged; single-use proof of the in-flight login. */
  csrf: z.string().min(1),
}).strict()

/** One stored browser session, inferred from {@link browserSessionRecordSchema}. */
export type BrowserSessionRecord = z.infer<typeof browserSessionRecordSchema>

/** The single declared table; a typed literal carries the key brand through {@link defineDomain}. */
const sessionsTable: DomainTableSpec<BrowserSessionId, BrowserSessionRecord> = {
  valueSchema: browserSessionRecordSchema,
}

/**
 * The browser-session domain declaration. Records are authoritative account
 * state: an invalid stored record rejects the open rather than being skipped.
 * The table is keyed by {@link BrowserSessionId}.
 */
export const browserSessionsDomainSpec = defineDomain({
  name: 'browser_sessions',
  version: 1,
  tables: { sessions: sessionsTable },
})

export type { UserPrincipal }
