/** The package's single public entry carries the identity contract and key codec. */

import { expect, it } from 'vitest'
import * as root from '@deepseek-ai/dsh-identity-protocol'
import { MockIdentityProvider } from '../src/mock.ts'

it('publishes the identity key codec from the package root', () => {
  expect(root.identityKeyOf({ providerId: 'p', tenantId: 't', subjectId: 's' })).toBe('p:t:s')
  expect(root.identityFromKey('p:t:s')).toEqual({ providerId: 'p', tenantId: 't', subjectId: 's' })
  expect(root.identityFromKey('p:t')).toBeUndefined()
  expect(root.identityFromKey('p::s')).toBeUndefined()
  expect(root.normalizeIdentity({ providerId: 'p', tenantId: '', subjectId: 's' }))
    .toEqual({ providerId: 'p', tenantId: 'default', subjectId: 's' })
  expect(root.IDENTITY_TENANT_PLACEHOLDER).toBe('default')
})

it('keeps the mock identity provider out of the published surface', () => {
  // Tests import the mock from its source module; no package entry exposes it.
  expect('MockIdentityProvider' in root).toBe(false)
  expect(MockIdentityProvider).toBeTypeOf('function')
})
