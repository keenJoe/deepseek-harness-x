import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRouteUsersPorts, planRouteUsers, renderEntryPortsOverlay } from '../src/route-users.ts'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-route-users-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('planRouteUsers', () => {
  it('lays out one entry then one backend per person', () => {
    const usersRoot = tempRoot()
    const plans = planRouteUsers({
      profile: 'web',
      users: ['alice', 'bob'],
      usersRoot,
      entryPort: 4200,
      entryPatches: ['entry.yml'],
      userPatches: ['user.yml'],
      appArgs: ['--no-open'],
      entry: ['node', 'dsh.js'],
      execArgv: [],
    })

    expect(plans).toHaveLength(3)
    expect(plans[0]).toMatchObject({ key: 'entry', home: join(usersRoot, 'entry'), port: 4200 })
    expect(plans[1]).toMatchObject({ key: 'alice', home: join(usersRoot, 'alice'), port: 4201 })
    expect(plans[2]).toMatchObject({ key: 'bob', home: join(usersRoot, 'bob'), port: 4202 })
    expect(plans[0]!.argv.slice(0, 6)).toEqual(['node', 'dsh.js', '--profile', 'web', '--patch', 'entry.yml'])
    expect(plans[0]!.argv[6]).toBe('--patch')
    expect(plans[0]!.argv[7]).toContain('route-users.ports.yml')
    expect(plans[0]!.argv[8]).toBe('--port')
    expect(plans[0]!.argv[9]).toBe('4200')
    expect(plans[0]!.argv[10]).toBe('--no-open')
    expect(plans[1]!.argv).toEqual([
      'node', 'dsh.js', '--profile', 'web', '--patch', 'user.yml', '--port', '4201', '--no-open',
    ])
    expect(plans[0]!.env.DSH_HOME).toBe(join(usersRoot, 'entry'))
    expect(plans[1]!.env.DSH_HOME).toBe(join(usersRoot, 'alice'))
  })

  it('rejects an entry port that leaves no room', () => {
    expect(() => planRouteUsers({ profile: 'web', users: ['alice'], entryPort: 65_535 })).toThrow('leaves room')
  })

  it('builds canonical route keys from the Feishu tenant and subjects', () => {
    const ports = buildRouteUsersPorts(['ou_1', 'ou_2'], 'tenant-7', 4300)
    expect(ports).toEqual({
      'feishu:tenant-7:ou_1': 4300,
      'feishu:tenant-7:ou_2': 4301,
    })
    const overlay = renderEntryPortsOverlay(ports)
    expect(overlay).toContain("'feishu:tenant-7:ou_1': 4300")
    expect(overlay).toContain('- id: route-users')
    expect(overlay).toContain('forwardSecret: !!js process.env.DSH_FORWARD_SECRET')
  })
})
