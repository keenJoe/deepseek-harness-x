/**
 * REAL end-to-end isolation through the built launcher: one supervised instance per person, then
 * the served surfaces. Each assertion observes what an operator can observe: the per-person home
 * on disk, the refusal of an anonymous request, and the refusal of the other person token.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planUserInstances, runServeUsers, type UserInstancePlan } from '../src/serve-users.ts'

/** Built launcher the supervised children run; this suite owns the built-artifact dependency. */
const DSH_BIN = resolve(import.meta.dirname, '../lib/bin.js')

/** Poll one URL until it answers with any status, or the deadline passes. */
async function waitForServer(port: number, deadlineMs = 90_000): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/`, { redirect: 'manual' })
      await response.text()
      return
    } catch {
      if (Date.now() > deadline) throw new Error('instance on port ' + String(port) + ' never answered')
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
  }
}

/** Collect one instance launch URL from the child output it printed. */
function tokenOf(lines: readonly string[], port: number): string {
  const prefix = 'http://127.0.0.1:' + String(port) + '/?token='
  for (const line of lines) {
    const at = line.indexOf(prefix)
    if (at >= 0) return line.slice(at + prefix.length).trim()
  }
  throw new Error('instance on port ' + String(port) + ' printed no launch URL')
}

describe.skipIf(!existsSync(DSH_BIN))('supervised instances keep two people apart', () => {
  it('serves each person only their own home and refuses the other token', { timeout: 180_000 }, async () => {
    // A child must not inherit the runner's own bootstrap: vitest exports node options
    // and VITEST_* markers that would make the harness load a worker entry instead.
    const inherited = { ...process.env }
    process.env = Object.fromEntries(
      Object.entries(inherited)
        .filter(([key]) => key !== 'NODE_OPTIONS' && key !== 'NODE_V8_COVERAGE' && !key.startsWith('VITEST')),
    )
    const root = mkdtempSync(join(tmpdir(), 'dsh-serve-users-isolation-'))
    const usersRoot = join(root, 'users')
    const controller = new AbortController()
    const output = new Map<string, string[]>()
    const children: ChildProcess[] = []
    const plans = planUserInstances({
      profile: 'web',
      users: ['alice', 'bob'],
      usersRoot,
      basePort: 4600,
      entry: [process.execPath, DSH_BIN],
      execArgv: [],
      appArgs: ['--no-open'],
    })
    const spawning = (plan: UserInstancePlan): ChildProcess => {
      const child = spawn(plan.argv[0]!, plan.argv.slice(1), { env: plan.env, stdio: ['ignore', 'pipe', 'pipe'] })
      const lines: string[] = []
      output.set(plan.key, lines)
      const sink = (chunk: Buffer): void => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line === '') continue
          lines.push(line)
          process.stderr.write('[' + plan.key + '] ' + line + '\n')
        }
      }
      child.stdout?.on('data', sink)
      child.stderr?.on('data', sink)
      children.push(child)
      return child
    }

    const running = runServeUsers(
      {
        profile: 'web',
        users: ['alice', 'bob'],
        usersRoot,
        basePort: 4600,
        entry: [process.execPath, DSH_BIN],
        execArgv: [],
        appArgs: ['--no-open'],
      },
      { signal: controller.signal, spawnInstance: spawning, log: () => {}, shutdownGraceMs: 10_000 },
    )
    try {
      await Promise.all(plans.map(plan => waitForServer(plan.port)))

      const anonymous: number[] = []
      for (const plan of plans) {
        anonymous.push((await fetch(`http://127.0.0.1:${String(plan.port)}/`, { redirect: 'manual' })).status)
      }
      expect(anonymous).toEqual([401, 401])

      const tokens = plans.map(plan => tokenOf(output.get(plan.key) ?? [], plan.port))
      const admitted = await fetch(`http://127.0.0.1:${String(plans[0]!.port)}/?token=${tokens[0]!}`, { redirect: 'manual' })
      expect(admitted.status).toBe(303)
      expect(admitted.headers.get('set-cookie')).not.toBeNull()
      await admitted.text()

      const crossed = await fetch(
        `http://127.0.0.1:${String(plans[1]!.port)}/?token=${tokens[0]!}`,
        { redirect: 'manual' },
      )
      expect(crossed.status).toBe(401)
      await crossed.text()

      expect(plans[0]!.home).not.toBe(plans[1]!.home)
      expect(plans[1]!.home.startsWith(plans[0]!.home)).toBe(false)
      expect(readdirSync(plans[0]!.home)).toContain('storages')
      expect(readdirSync(plans[1]!.home)).toContain('storages')
    } finally {
      controller.abort()
      await running
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true })
      process.env = inherited
    }
  })
})
