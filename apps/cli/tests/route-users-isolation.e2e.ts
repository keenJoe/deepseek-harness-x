/**
 * REAL end-to-end through the built launcher: one entry signs in a Feishu person and routes
 * them to their own harness backend, which verifies the entry-signed caller and serves only its
 * own home. A mock Feishu keeps the run offline while exercising the real provider envelope.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runRouteUsers } from '../src/route-users.ts'

const DSH_BIN = resolve(import.meta.dirname, '../lib/bin.js')
const FORWARD_SECRET = 'shared-forward-secret'
const PROVIDER_ID = 'feishu'
const APP_ID = 'cli_app_123'
const APP_SECRET = 'app-secret'
const OPEN_ID = 'ou_1'
const TENANT = 'tenant-7'

async function waitForServer(port: number, deadlineMs = 90_000): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    try {
      const response = await fetch('http://127.0.0.1:' + String(port) + '/', { redirect: 'manual' })
      await response.text()
      return
    } catch {
      if (Date.now() > deadline) throw new Error('port ' + String(port) + ' never answered')
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
  }
}

async function startFeishu(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/oauth/token') && request.method === 'POST') {
      request.resume()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 0, data: { access_token: 'u-abc' } }))
      return
    }
    if (request.url?.endsWith('/user_info')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 0, data: { open_id: OPEN_ID, tenant_key: TENANT, name: 'Alice' } }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('feishu did not bind')
  return {
    origin: 'http://127.0.0.1:' + String(address.port),
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((e) => { if (e === undefined) resolveClose(); else reject(e) })
    }),
  }
}

describe.skipIf(!existsSync(DSH_BIN))('route-users serves people behind one entry', () => {
  it('routes a signed-in person to their own backend', { timeout: 240_000 }, async () => {
    const inherited = { ...process.env }
    process.env = Object.fromEntries(Object.entries(inherited).filter(([key]) => key !== 'NODE_OPTIONS' && key !== 'NODE_V8_COVERAGE' && !key.startsWith('VITEST')))
    const feishu = await startFeishu()
    const root = mkdtempSync(join(tmpdir(), 'dsh-route-users-e2e-'))
    const usersRoot = join(root, 'users')
    const controller = new AbortController()
    const children: ChildProcess[] = []
    let running: Promise<number> | undefined
    try {
      const entryOverlay = join(root, 'entry-feishu.yml')
      writeFileSync(entryOverlay, [
        '- id: web-runtime',
        '  disabled: true',
        '- id: identity-feishu',
        '  disabled: false',
        '  config:',
        '    id: ' + PROVIDER_ID,
        '    appId: ' + APP_ID,
        '    appSecret: ' + APP_SECRET,
        '    baseUrl: ' + feishu.origin + '/open-apis/',
      ].join('\n') + '\n')
      const backendOverlay = join(root, 'backend-trust.yml')
      writeFileSync(backendOverlay, [
        '- id: route-users-backend',
        '  disabled: false',
        '  config:',
        '    forwardSecret: !!js process.env.DSH_FORWARD_SECRET',
      ].join('\n') + '\n')

      running = runRouteUsers(
        {
          profile: 'web',
          users: [OPEN_ID],
          usersRoot,
          entryPort: 4800,
          tenant: TENANT,
          entryPatches: [entryOverlay],
          userPatches: [backendOverlay],
          forwardSecret: FORWARD_SECRET,
          appArgs: ['--no-open'],
          entry: [process.execPath, DSH_BIN],
          execArgv: [],
        },
        {
          signal: controller.signal,
          spawnInstance: (plan) => {
            const child = spawn(plan.argv[0]!, plan.argv.slice(1), { env: plan.env, stdio: 'inherit' })
            children.push(child)
            return child
          },
          log: () => {},
          shutdownGraceMs: 10_000,
        },
      )

      await waitForServer(4800)
      const entryOrigin = 'http://127.0.0.1:4800'

      const login = await fetch(entryOrigin + '/login?provider=' + PROVIDER_ID, { redirect: 'manual' })
      const authorization = new URL(login.headers.get('location') ?? 'http://invalid.invalid')
      const state = authorization.searchParams.get('state') ?? ''
      const callback = await fetch(entryOrigin + '/login/callback?state=' + encodeURIComponent(state) + '&code=c', { redirect: 'manual' })
      const cookie = callback.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
      expect(cookie).not.toBe('')

      const routed = await fetch(entryOrigin + '/', { redirect: 'manual', headers: { cookie } })
      expect(routed.status).toBe(200)
      const routedBody = await routed.text()
      expect(routedBody).toContain('<!doctype html>')
      // The backend home was created and owns its own storages directory.
      expect(existsSync(join(usersRoot, OPEN_ID, 'storages'))).toBe(true)
    } finally {
      controller.abort()
      if (running !== undefined) await running
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await feishu.close()
      rmSync(root, { recursive: true, force: true })
      process.env = inherited
    }
  })
})
