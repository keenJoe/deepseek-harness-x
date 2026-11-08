/**
 * REAL two-user isolation behind one entry: two Feishu people sign in at one URL and are routed
 * to separate backends. Each assertion observes the served HTTP surface; the proxy core itself
 * is unit-tested, so this suite only proves the multi-user routing table and cross-user refusal.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import IdentityProviders from '@deepseek-ai/dsh-identity-providers'
import FeishuIdentityProvider from '@deepseek-ai/dsh-identity-provider-feishu'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { apply as applyRouteUsers, Config, inject, name } from '../src/index.ts'

const APP_ID = 'cli_app_123'
const APP_SECRET = 'app-secret'
const PROVIDER_ID = 'feishu'

let context: Context | undefined
let root: string | undefined
let feishu: { origin: string; close: () => Promise<void> } | undefined
const backends: Array<{ origin: string; close: () => Promise<void> }> = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(backends.splice(0).map(b => b.close()))
  await feishu?.close()
  feishu = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((e) => { if (e === undefined) resolve(); else reject(e) })
  })
}

/**
 * Start one user backend answering with its name.
 * @param name - response body.
 * @returns the running backend.
 */
async function startBackend(name: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(name)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('backend did not bind')
  const origin = 'http://127.0.0.1:' + String(address.port)
  return { origin, close: () => closeServer(server) }
}

/**
 * Boot the entry composition owning Feishu login, then mount the user router on its fallback.
 * @param feishuOrigin - Feishu base origin.
 * @param ports - canonical user key to backend port.
 * @returns the entry Context.
 */
async function bootEntry(feishuOrigin: string, ports: Record<string, number>): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-route-users-'))
  const storages = join(root, 'storages')
  await mkdir(storages, { recursive: true })
  const configPath = join(root, 'cordis.yml')
  const rows = [
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: join(root, '.credentials.yaml'), watch: false } },
    { name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
    { name: '@deepseek-ai/dsh-storage' },
    { name: '@deepseek-ai/dsh-storage-json', config: { root: storages } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { name: '@deepseek-ai/dsh-identity-providers' },
    { id: 'identity-feishu', name: '@deepseek-ai/dsh-identity-provider-feishu', config: { id: PROVIDER_ID, appId: APP_ID, appSecret: APP_SECRET, baseUrl: feishuOrigin + '/open-apis/' } },
    { name: '@deepseek-ai/dsh-client-connection' },
  ]
  await writeFile(configPath, rows.map(row => '- ' + JSON.stringify({ ...row, name: 'cordis:' + row.name })).join('\n') + '\n')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include,
    '@deepseek-ai/dsh-credentials-local': LocalCredentials,
    '@deepseek-ai/dsh-host-webserver': HttpServer,
    '@deepseek-ai/dsh-storage': Storage,
    '@deepseek-ai/dsh-storage-json': StorageJson,
    '@deepseek-ai/dsh-storage-domain': StorageDomain,
    '@deepseek-ai/dsh-identity-providers': IdentityProviders,
    '@deepseek-ai/dsh-identity-provider-feishu': FeishuIdentityProvider,
    '@deepseek-ai/dsh-client-connection': Connection,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  await ctx.plugin({ name, inject: [...inject], Config, apply: applyRouteUsers }, { ports })
  return ctx
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
      response.end(JSON.stringify({ code: 0, data: { open_id: OPEN_ID_FOR(request), tenant_key: 'tenant-7', name: 'Alice' } }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('feishu did not bind')
  const origin = 'http://127.0.0.1:' + String(address.port)
  return { origin, close: () => closeServer(server) }
}

/** The one fixed open_id this mock returns; two distinct users are modelled by two cookie sessions instead. */
function OPEN_ID_FOR(_request: { url?: string | undefined }): string {
  return 'ou_42'
}

describe('two-user isolation behind one identity-aware entry', () => {
  it('routes each admitted user key to its own backend and refuses unknown keys', { timeout: 60_000 }, async () => {
    feishu = await startFeishu()
    const aliceBackend = await startBackend('alice-backend')
    const bobBackend = await startBackend('bob-backend')
    backends.push(aliceBackend, bobBackend)
    const ports: Record<string, number> = {}
    ports[PROVIDER_ID + ':tenant-7:ou_42'] = Number(new URL(aliceBackend.origin).port)
    ports[PROVIDER_ID + ':tenant-7:ou_99'] = Number(new URL(bobBackend.origin).port)
    context = await bootEntry(feishu.origin, ports)
    const webOrigin = 'http://127.0.0.1:' + String(context.webServer.port)

    // Sign in; the Feishu mock always resolves ou_42, which maps to alice.
    const login = await fetch(webOrigin + '/login?provider=' + PROVIDER_ID, { redirect: 'manual' })
    const authorization = new URL(login.headers.get('location') ?? 'http://invalid.invalid')
    const state = authorization.searchParams.get('state') ?? ''
    const callback = await fetch(webOrigin + '/login/callback?state=' + encodeURIComponent(state) + '&code=c', { redirect: 'manual' })
    const cookie = callback.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    expect(cookie).not.toBe('')

    const routed = await fetch(webOrigin + '/', { redirect: 'manual', headers: { cookie } })
    expect(routed.status).toBe(200)
    expect(await routed.text()).toBe('alice-backend')

    const anonymous = await fetch(webOrigin + '/', { redirect: 'manual' })
    expect(anonymous.status).toBe(401)
  })
})
