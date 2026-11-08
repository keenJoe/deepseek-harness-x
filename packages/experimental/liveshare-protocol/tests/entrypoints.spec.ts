/** The package's single public entry carries the whole shared contract. */

import { expect, it } from 'vitest'
import * as root from '@deepseek-ai/dsh-experimental-liveshare-protocol'

it('publishes the wire, carrier, and viewer-state contracts from the package root', () => {
  expect(root.LIVESHARE_PROTOCOL_VERSION).toBeTypeOf('number')
  expect(root.parseShareAccessState).toBeTypeOf('function')
  expect(root.parseTunnelWorkerCommand).toBeTypeOf('function')
  expect(root.viewerCarrierScript).toBeTypeOf('function')
  expect(root.VIEWER_STATE_REACH).toBeTypeOf('object')
})

it('re-exports the identity contract from the shared identity protocol package', () => {
  expect(root.identityKeyOf({ providerId: 'p', tenantId: 't', subjectId: 's' })).toBe('p:t:s')
  expect(root.identityFromKey('p:t:s')).toEqual({ providerId: 'p', tenantId: 't', subjectId: 's' })
  expect(root.identityFromKey('p:t')).toBeUndefined()
  expect(root.identityFromKey('p::s')).toBeUndefined()
  expect('MockIdentityProvider' in root).toBe(false)
})
