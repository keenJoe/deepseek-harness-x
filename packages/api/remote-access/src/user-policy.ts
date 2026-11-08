/**
 * Remote access policy confining one logged-in user to their own Sessions and Workspaces.
 *
 * The Gateway decides every call that speaks for a `user` Peer, and every Session notification it
 * forwards to one, from the bindings this policy lists; the Session and Workspace controllers filter
 * list results through the same bindings, and every user page opens with the snapshot computed from
 * them. A user holds a global role for the UI surface shared by every user, plus Session and Workspace
 * roles on exactly the resources whose owning id resolves to the caller's canonical user key, so a user
 * cannot reach another user's Session or Workspace by naming a different id. Owner-only namespaces
 * (`account`, `credentials`, `settings`, `terminal`, the directory picker, and the owner-only
 * Session verbs) resolve to no user binding and stay refused.
 *
 * Every rule reads in-memory ownership facts synchronously: the binding computation asks the host's
 * per-user registries for the ids the caller's key owns.
 *
 * @module @deepseek-ai/dsh-api-remote-access/src/user-policy
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { userId, type UserPrincipal } from '@deepseek-ai/dsh-user-principal'
import type {
  RemoteAccessAction,
  RemoteAccessBinding,
  RemoteAccessPolicy,
  RemoteAccessRequest,
  RemoteAccessRole,
} from './types.ts'

/** Endpoints every logged-in user's UI surface needs, reached before any owned resource is named. */
const USER_GLOBAL_ROLE: RemoteAccessRole<'global'> = {
  name: 'user:global',
  resource: 'global',
  actions: [
    'commands/list',
    'llm/listConfigurableProviders',
    'llm/listProviders',
    'session/canOpenWorkspacePath',
    'session/control',
    'session/create',
    'session/initializeDefaultModel',
    'session/list',
    'session/modelCatalog',
    'session/search',
    'workspace/create',
    'workspace/follow',
    'workspace/initializeDefault',
  ],
}

/** Reads of one Session the user owns. */
const SESSION_READS: readonly RemoteAccessAction[] = [
  'commands/list',
  'fileUploads/upload',
  'goals/get',
  'session/attachment',
  'session/control',
  'session/events',
  'session/follow',
  'session/list',
  'session/observeEvent',
  'session/observeProjections',
  'session/observeState',
  'session/page',
  'session/projections',
  'session/state',
  'session/wait',
  'skills/list',
  'toolResults/watch',
  'workspace/follow',
]

/** Session notifications forwarded only for Sessions the user owns. */
const SESSION_EVENTS: readonly RemoteAccessAction[] = [
  'event:api-session/activity',
  'event:api-session/added',
  'event:api-session/error',
  'event:api-session/removed',
  'event:api-session/status',
]

/** Session writes and Session-scoped Workspace verbs on one Session the user owns. */
const SESSION_WRITES: readonly RemoteAccessAction[] = [
  'session/create',
  'session/selectModel',
  'session/rename',
  'session/fork',
  'session/prompt',
  'session/updateQueue',
  'session/cancel',
  'workspace/insertSessionBefore',
  'workspace/archiveSession',
  'workspace/unarchiveSession',
  'workspace/pinSession',
  'workspace/unpinSession',
]

/** Reads, writes, and Session-scoped Workspace verbs on one Session the user owns. */
const USER_SESSION_ROLE: RemoteAccessRole<'session'> = {
  name: 'user:session',
  resource: 'session',
  actions: [...SESSION_READS, ...SESSION_EVENTS, ...SESSION_WRITES],
}

/** Reads, mutations, and the Workspace-and-Session scoped move of one Workspace the user owns. */
const USER_WORKSPACE_ROLE: RemoteAccessRole<'workspace'> = {
  name: 'user:workspace',
  resource: 'workspace',
  actions: ['workspace/follow', 'workspace/rename', 'workspace/delete', 'workspace/insertBefore', 'workspace/insertSessionBefore'],
}

/** A user named a Session or Workspace they do not own. */
const USER_RESOURCE_NOT_OWNED_CODE = 'user/resource-not-owned'

/** A user reached an endpoint no owned resource serves; owner-only surfaces stay refused this way. */
const USER_NO_ACCESS_CODE = 'user/no-access'

/**
 * Why no binding allows one user request: the named resource is another user's, or the endpoint is
 * owner-only.
 *
 * The user's own Sessions and Workspaces carry bindings whose roles list every action the user may take
 * there, so a request refused here either named a foreign resource or an endpoint no role lists.
 * @param request - the refused request.
 * @returns the refusal code a user page classifies.
 */
function explainUserRefusal(request: RemoteAccessRequest<UserPrincipal>): string {
  for (const resource of request.resources) {
    if (resource.kind === 'global') continue
    return USER_RESOURCE_NOT_OWNED_CODE
  }
  return USER_NO_ACCESS_CODE
}

/** Per-user ownership facts this policy reads, all synchronous and held in memory by the host. */
export interface UserAccessFacts {
  /**
   * The Sessions the caller's canonical key owns.
   * @param key - canonical user key: `String(userId(principal))` of the caller.
   * @returns the owned Session ids in the host's order.
   */
  readonly sessions: (key: string) => readonly SessionId[]
  /**
   * The Workspaces the caller's canonical key owns.
   * @param key - canonical user key: `String(userId(principal))` of the caller.
   * @returns the owned Workspace ids in registry order.
   */
  readonly workspaces: (key: string) => readonly WorkspaceId[]
}

/**
 * Build the `user` policy for this host's logged-in users.
 * @param facts - per-user ownership the rules read.
 * @returns the policy the host registers for the `user` principal kind.
 */
export function createUserAccessPolicy(facts: UserAccessFacts): RemoteAccessPolicy<UserPrincipal> {
  return {
    bindings(user): readonly RemoteAccessBinding[] {
      const key = String(userId(user))
      const bindings: RemoteAccessBinding[] = [
        { role: USER_GLOBAL_ROLE, resource: { kind: 'global' } },
      ]
      for (const id of facts.sessions(key)) {
        bindings.push({ role: USER_SESSION_ROLE, resource: { kind: 'session', id } })
      }
      for (const id of facts.workspaces(key)) {
        bindings.push({ role: USER_WORKSPACE_ROLE, resource: { kind: 'workspace', id } })
      }
      return bindings
    },
    explain: request => explainUserRefusal(request),
  }
}
