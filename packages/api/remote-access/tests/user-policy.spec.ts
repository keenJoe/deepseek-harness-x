/**
 * The `user` remote access policy, decided through a real remote access service: which actions a
 * logged-in user may take on which resource, which Session notifications it receives, the refusal
 * codes the user page classifies, and the access snapshot the user page opens with.
 *
 * A user's key (the canonical percent-encoded provider:tenant:subject triple) owns its Sessions and
 * Workspaces; the policy binds only those ids, so naming a different id reaches no binding and is
 * refused `user/resource-not-owned`. The owner keeps every owner-only surface, and no user is ever
 * assigned owner access.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService, {
  type RemoteAccessAction,
  type RemoteAccessGrant,
  type RemoteAccessResource,
} from '../src/index.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { userId, userPrincipal, type UserPrincipal } from '@deepseek-ai/dsh-user-principal'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { createUserAccessPolicy, type UserAccessFacts } from '../src/user-policy.ts'

/** One user triple; the subject id alone distinguishes the users these cases compare. */
interface UserTriple {
  readonly providerId: string
  readonly tenantId: string
  readonly subjectId: string
  readonly displayName: string
}

/**
 * Build the principal one triple names.
 * @param triple - provider, tenant, subject, and display name of the caller.
 * @returns the user principal those fields identify.
 */
function user(triple: UserTriple): UserPrincipal {
  const principal = userPrincipal(triple)
  if (principal === undefined) throw new Error(`unreachable: ${triple.providerId}/${triple.subjectId} has an empty identity`)
  return principal
}

const ALICE = user({ providerId: 'oidc', tenantId: 'tenant-a', subjectId: 'alice', displayName: 'Alice' })
const BOB = user({ providerId: 'oidc', tenantId: 'tenant-a', subjectId: 'bob', displayName: 'Bob' })
/** The same subject issued by another provider is a different user. */
const ALICE_ELSEWHERE = user({ providerId: 'sso', tenantId: 'tenant-a', subjectId: 'alice', displayName: 'Alice' })

const GLOBAL: RemoteAccessResource = { kind: 'global' }
const session = (id: string): RemoteAccessResource => ({ kind: 'session', id: SessionId(id) })
const workspace = (id: string): RemoteAccessResource => ({ kind: 'workspace', id: WorkspaceId(id) })

/**
 * The actions the served user page's startup and render paths need, listed once here as the contract
 * the policy must cover; the assembled-page fixture models its access snapshot from the same set.
 */
const GLOBAL_ACTIONS = [
  'commands/list', 'llm/listConfigurableProviders', 'llm/listProviders', 'session/canOpenWorkspacePath',
  'session/control', 'session/create', 'session/initializeDefaultModel', 'session/list',
  'session/modelCatalog', 'session/search', 'workspace/create', 'workspace/follow', 'workspace/initializeDefault',
] as const
/** Session reads the served user page's startup and render paths need. */
const SESSION_READS = [
  'commands/list', 'fileUploads/upload', 'goals/get', 'session/attachment', 'session/control',
  'session/events', 'session/follow', 'session/list', 'session/observeEvent', 'session/observeProjections',
  'session/observeState', 'session/page', 'session/projections', 'session/state', 'session/wait',
  'skills/list', 'toolResults/watch', 'workspace/follow',
] as const
/** Session notifications forwarded only for Sessions the user owns. */
const SESSION_EVENTS = [
  'event:api-session/activity', 'event:api-session/added', 'event:api-session/error',
  'event:api-session/removed', 'event:api-session/status',
] as const
/** Session writes and Session-scoped Workspace verbs on one Session the user owns. */
const SESSION_WRITES = [
  'session/create', 'session/selectModel', 'session/rename', 'session/fork', 'session/prompt',
  'session/updateQueue', 'session/cancel', 'workspace/insertSessionBefore', 'workspace/archiveSession',
  'workspace/unarchiveSession', 'workspace/pinSession', 'workspace/unpinSession',
] as const
/** Workspace reads and mutations on one Workspace the user owns. */
const WORKSPACE_ACTIONS = ['workspace/follow', 'workspace/rename', 'workspace/delete', 'workspace/insertBefore', 'workspace/insertSessionBefore'] as const

const ALLOW = { kind: 'allow' }
const deny = (reason: string) => ({ kind: 'deny', reason })

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Ownership facts keyed by the canonical user key; the host's per-user registries stand in for them. */
async function fixture(owned: Record<string, { readonly sessions?: readonly string[]; readonly workspaces?: readonly string[] }> = {}) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  const access = ctx.remoteAccess
  const facts: UserAccessFacts = {
    sessions: key => (owned[key]?.sessions ?? []).map(SessionId),
    workspaces: key => (owned[key]?.workspaces ?? []).map(WorkspaceId),
  }
  access.registerPolicy('user', createUserAccessPolicy(facts))
  const decide = (action: RemoteAccessAction, resource: RemoteAccessResource, principal: UserPrincipal = ALICE) =>
    access.decide({ principal, action, resources: [resource] })
  const grants = (principal: UserPrincipal = ALICE): readonly RemoteAccessGrant[] => {
    const baseline = access.snapshotFor(principal)
    return baseline.owner ? [] : baseline.grants
  }
  return { access, decide, grants }
}

/** The canonical key of one user principal, matching the policy's own lookup. */
function keyOf(principal: UserPrincipal): string {
  return String(userId(principal))
}

describe('user access policy', () => {
  it('allows the owner without any policy and never assigns owner access to a user', async () => {
    const { access } = await fixture()
    expect(access.decide({ principal: { kind: 'owner' }, action: 'settings/describe', resources: [GLOBAL] }))
      .toEqual(ALLOW)
    expect(access.snapshotFor({ kind: 'owner' })).toEqual({ type: 'baseline', owner: true })
    expect(access.snapshotFor(ALICE).owner).toBe(false)
  })

  it('allows the global reads and writes and refuses every other action on the global resource', async () => {
    const { decide } = await fixture({ [keyOf(ALICE)]: {} })
    for (const action of GLOBAL_ACTIONS) expect(decide(action, GLOBAL)).toEqual(ALLOW)
    for (const action of ['settings/describe', 'account/watch', 'session/openWorkspacePath',
      'session/workspacePathApplications', 'pluginManager/listPlugins', 'job/list', 'session/page',
      'event:api-session/status'] as const) {
      expect(decide(action, GLOBAL)).toEqual(deny('user/no-access'))
    }
  })

  it('allows every Session action and notification on a Session the user owns, and refuses a foreign one', async () => {
    const { decide } = await fixture({ [keyOf(ALICE)]: { sessions: ['s1'] } })
    for (const action of SESSION_READS) expect(decide(action, session('s1'))).toEqual(ALLOW)
    for (const action of SESSION_WRITES) expect(decide(action, session('s1'))).toEqual(ALLOW)
    for (const action of SESSION_EVENTS) expect(decide(action, session('s1'))).toEqual(ALLOW)
    for (const action of [...SESSION_READS, ...SESSION_WRITES, ...SESSION_EVENTS]) {
      expect(decide(action, session('s2'))).toEqual(deny('user/resource-not-owned'))
    }
  })

  it('allows Workspace actions on an owned Workspace and refuses a foreign one', async () => {
    const { decide } = await fixture({ [keyOf(ALICE)]: { workspaces: ['w1'] } })
    for (const action of WORKSPACE_ACTIONS) expect(decide(action, workspace('w1'))).toEqual(ALLOW)
    for (const action of WORKSPACE_ACTIONS) expect(decide(action, workspace('w2'))).toEqual(deny('user/resource-not-owned'))
  })

  it("keeps a Session's owner-only verbs refused even on an owned Session", async () => {
    const { decide } = await fixture({ [keyOf(ALICE)]: { sessions: ['s1'] } })
    for (const action of ['session/openWorkspacePath', 'session/workspacePathApplications'] as const) {
      expect(decide(action, session('s1'))).toEqual(deny('user/resource-not-owned'))
    }
  })

  it("never lets one user reach another user's Session or Workspace by naming its id", async () => {
    const { decide } = await fixture({ [keyOf(ALICE)]: { sessions: ['s1'], workspaces: ['w1'] } })
    expect(decide('session/page', session('s1'), BOB)).toEqual(deny('user/resource-not-owned'))
    expect(decide('workspace/delete', workspace('w1'), BOB)).toEqual(deny('user/resource-not-owned'))
    // The same subject id issued by another provider is another user, with its own key and nothing owned.
    expect(decide('session/page', session('s1'), ALICE_ELSEWHERE)).toEqual(deny('user/resource-not-owned'))
  })

  it('requires every resource a call touches to be owned', async () => {
    const { access } = await fixture({ [keyOf(ALICE)]: { sessions: ['s1'], workspaces: ['w1'] } })
    expect(access.decide({ principal: ALICE, action: 'workspace/insertSessionBefore', resources: [workspace('w1'), session('s1')] }))
      .toEqual(ALLOW)
    expect(access.decide({ principal: ALICE, action: 'workspace/insertSessionBefore', resources: [workspace('w1'), session('s2')] }))
      .toEqual(deny('user/resource-not-owned'))
  })

  it('keeps owner-only surfaces out of the snapshot and lists every owned action', async () => {
    const { grants } = await fixture({ [keyOf(ALICE)]: { sessions: ['s1'], workspaces: ['w1'] } })
    const sessionActions = [...SESSION_READS, ...SESSION_WRITES].sort()
    expect(grants()).toEqual([
      { resource: GLOBAL, actions: [...GLOBAL_ACTIONS].sort() },
      { resource: session('s1'), actions: sessionActions },
      { resource: workspace('w1'), actions: [...WORKSPACE_ACTIONS].sort() },
    ])
    const granted = new Set(grants().flatMap(grant => [...grant.actions]))
    for (const action of ['settings/describe', 'account/watch', 'session/openWorkspacePath', 'job/list']) {
      expect(granted.has(action)).toBe(false)
    }
    for (const action of SESSION_EVENTS) expect(granted.has(action)).toBe(false)
  })

  it('opens a user with no owned resources on the global grant alone', async () => {
    const { grants } = await fixture({ [keyOf(ALICE)]: {} })
    expect(grants()).toEqual([{ resource: GLOBAL, actions: [...GLOBAL_ACTIONS].sort() }])
    expect(grants(BOB)).toEqual([{ resource: GLOBAL, actions: [...GLOBAL_ACTIONS].sort() }])
  })
})
