import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planUserInstances, runServeUsers, type UserInstancePlan } from '../src/serve-users.ts'

/** Child that stays alive until it receives SIGTERM, like one harness instance. */
const STAY_ALIVE = "process.on('SIGTERM', () => { process.exit(0) }); setInterval(() => {}, 1000)"

const roots: string[] = []
const children: ChildProcess[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-serve-users-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('planUserInstances', () => {
  it('gives each person their own home, port, and DSH_HOME', () => {
    const usersRoot = tempRoot()
    const plans = planUserInstances({
      profile: 'web',
      users: ['alice', 'bob'],
      usersRoot,
      basePort: 4100,
      patchFiles: ['multi-user.yml'],
      appArgs: ['--no-open'],
      entry: ['node', 'dsh.js'],
      execArgv: [],
    })

    expect(plans).toHaveLength(2)
    expect(plans[0]).toMatchObject({ key: 'alice', home: join(usersRoot, 'alice'), port: 4100 })
    expect(plans[1]).toMatchObject({ key: 'bob', home: join(usersRoot, 'bob'), port: 4101 })
    expect(plans[0]!.argv).toEqual([
      'node', 'dsh.js', '--profile', 'web', '--patch', 'multi-user.yml', '--port', '4100', '--no-open',
    ])
    expect(plans[0]!.env.DSH_HOME).toBe(join(usersRoot, 'alice'))
    expect(plans[1]!.env.DSH_HOME).toBe(join(usersRoot, 'bob'))
  })

  it('follows the harness users directory by default', () => {
    const home = tempRoot()
    vi.stubEnv('DSH_HOME', home)

    const [plan] = planUserInstances({ profile: 'web', users: ['alice'] })

    expect(plan!.home).toBe(join(home, 'users', 'alice'))
  })

  it('rejects a missing, repeated, or unusable key and an overflowing port', () => {
    expect(() => planUserInstances({ profile: 'web', users: [] })).toThrow('at least one --users value')
    expect(() => planUserInstances({ profile: 'web', users: ['alice', 'alice'] })).toThrow('listed twice')
    expect(() => planUserInstances({ profile: 'web', users: ['../escape'] })).toThrow('not a usable user key')
    expect(() => planUserInstances({ profile: 'web', users: ['alice', 'bob'], basePort: 65_535 })).toThrow('leaves room')
  })
})

describe('runServeUsers', () => {
  it('starts every instance and stops them all on request', async () => {
    const usersRoot = tempRoot()
    const controller = new AbortController()
    const lines: string[] = []
    const started: UserInstancePlan[] = []
    const spawning = (plan: UserInstancePlan): ChildProcess => {
      started.push(plan)
      const child = spawn(process.execPath, ['-e', STAY_ALIVE], { stdio: 'ignore' })
      children.push(child)
      return child
    }

    const running = runServeUsers(
      { profile: 'web', users: ['alice', 'bob'], usersRoot, basePort: 4200 },
      { signal: controller.signal, spawnInstance: spawning, log: line => lines.push(line), shutdownGraceMs: 2_000 },
    )
    await vi.waitFor(() => { expect(started).toHaveLength(2) })

    controller.abort()

    await expect(running).resolves.toBe(0)
    expect(lines).toEqual([
      'serve-users: alice -> http://127.0.0.1:4200 (home ' + join(usersRoot, 'alice') + ')',
      'serve-users: bob -> http://127.0.0.1:4201 (home ' + join(usersRoot, 'bob') + ')',
    ])
    expect(statSync(join(usersRoot, 'alice')).isDirectory()).toBe(true)
    expect(lines.some(line => line.includes('exited unexpectedly'))).toBe(false)
    for (const child of children) expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('stops every instance when one exits unexpectedly', async () => {
    const usersRoot = tempRoot()
    const lines: string[] = []
    const spawning = (plan: UserInstancePlan): ChildProcess => {
      const script = plan.key === 'alice' ? 'process.exit(3)' : STAY_ALIVE
      const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
      children.push(child)
      return child
    }

    await expect(runServeUsers(
      { profile: 'web', users: ['alice', 'bob'], usersRoot, basePort: 4300 },
      { spawnInstance: spawning, log: line => lines.push(line), shutdownGraceMs: 2_000 },
    )).resolves.toBe(3)

    expect(lines.some(line => line.includes('alice exited unexpectedly'))).toBe(true)
    for (const child of children) expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })
})
