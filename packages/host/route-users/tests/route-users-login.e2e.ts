/**
 * REAL A1 core loop: one entry owns the Feishu login and routes the signed-in browser to the
 * backend its canonical user key maps to. Login runs through real HTTP against the harness
 * webserver; the identity-aware proxy then admits the cookie and forwards to an echo backend.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
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
const OPEN_ID = 'ou_42'
const TENANT = 'tenant-7'

let context: Context | undefined
let root: string | undefined
let feishu: { origin: string; close: () => Promise<void> } | undefined
let entry: { close: () => Promise<void> } | undefined
let backend: { origin: string; hits: string[]; close: () => Promise<void> } | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await entry?.close()
  entry = undefined
  await backend?.close()
  backend = undefined
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
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('feishu did not bind')
  const origin = 'http://127.0.0.1:' + String(address.port)
  return { origin, close: () => closeServer(server) }
}

/**
 * Boot the entry: a real Web composition that owns the Feishu login and the session store.
 * @param feishuOrigin - Feishu base origin.
 * @returns the loaded entry Context.
 */
async function bootEntry(feishuOrigin: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-route-entry-'))
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
  return ctx
}

async function startBackend(body: string): Promise<{ origin: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = []
  const server = createServer((_request, response) => {
    hits.push(body)
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('backend did not bind')
  const origin = 'http://127.0.0.1:' + String(address.port)
  return { origin, hits, close: () => closeServer(server) }
}

describe('entry-owned Feishu login routing', () => {
  it('admits the login cookie and routes it to the owning backend', { timeout: 60_000 }, async () => {
    feishu = await startFeishu()
    if (feishu === undefined) throw new Error('feishu did not start')
    const feishuOrigin: string = feishu.origin
    const entryCtx = await bootEntry(feishuOrigin)
    context = entryCtx
    const webOrigin = 'http://127.0.0.1:' + String(entryCtx.webServer.port)

    backend = await startBackend('alice-backend')
    const aliceKey = PROVIDER_ID + ':' + TENANT + ':' + OPEN_ID
    if (backend === undefined) throw new Error('backend did not start')
    const alicePort = Number(new URL(backend.origin).port)
    await context.plugin(
      { name, inject: [...inject], Config, apply: applyRouteUsers },
      { ports: { [aliceKey]: alicePort } },
    )

    // Sign in through the ENTRY’s own webserver (the authority the cookie binds to).
    const login = await fetch(webOrigin + '/login?provider=' + PROVIDER_ID, { redirect: 'manual' })
    const authorization = new URL(login.headers.get('location') ?? 'http://invalid.invalid')
    const state = authorization.searchParams.get('state') ?? ''
    const callback = await fetch(webOrigin + '/login/callback?state=' + encodeURIComponent(state) + '&code=c', { redirect: 'manual' })
    const cookie = callback.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    expect(cookie).not.toBe('')

    try {
      const routed = await fetch(webOrigin + '/', { redirect: 'manual', headers: { cookie } })
      expect(routed.status).toBe(200)
      expect(await routed.text()).toBe('alice-backend')
      expect(backend.hits).toEqual(['alice-backend'])

      const anonymous = await fetch(webOrigin + '/', { redirect: 'manual' })
      expect(anonymous.status).toBe(401)
    } finally {
      // The entry Context disposal in afterEach releases the fallback seat.
    }
  })
})
