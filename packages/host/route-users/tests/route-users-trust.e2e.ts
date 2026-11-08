/**
 * REAL end-to-end trust: the entry signs the forwarded caller and a hardened backend admits it
 * through ConnectionTrust, so a request without the signed header is refused by the backend itself.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
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
const FORWARD_SECRET = 'shared-forward-secret'

let contexts: Context[] = []
let root: string | undefined
let feishu: { origin: string; close: () => Promise<void> } | undefined
let backend: { origin: string; close: () => Promise<void> } | undefined

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(c => c.fiber.dispose()))
  await backend?.close()
  backend = undefined
  await feishu?.close()
  feishu = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
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

/** Hardened backend: admits ONLY through ConnectionTrust and echoes the admitted subject. */
async function startBackend(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(request.headers)) if (typeof v === 'string') headers[k] = v
    const admission = backendCtx!.connection.admit({ headers })
    if (!('peer' in admission)) {
      response.writeHead(401)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/plain' })
    const subject = admission.peer.principal.kind === 'user' ? admission.peer.principal.subjectId : 'other'
    response.end('backend:' + subject)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('backend did not bind')
  const origin = 'http://127.0.0.1:' + String(address.port)
  return { origin, close: () => closeServer(server) }
}

let backendCtx: Context | undefined

async function bootBackend(home: string): Promise<Context> {
  const storages = join(home, 'storages')
  await mkdir(storages, { recursive: true })
  const configPath = join(home, 'cordis.yml')
  const rows = [
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: join(home, '.credentials.yaml'), watch: false } },
    { name: '@deepseek-ai/dsh-storage' },
    { name: '@deepseek-ai/dsh-storage-json', config: { root: storages } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { name: '@deepseek-ai/dsh-client-connection' },
  ]
  await writeFile(configPath, rows.map(r => '- ' + JSON.stringify({ ...r, name: 'cordis:' + r.name })).join('\n') + '\n')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include,
    '@deepseek-ai/dsh-credentials-local': LocalCredentials,
    '@deepseek-ai/dsh-storage': Storage,
    '@deepseek-ai/dsh-storage-json': StorageJson,
    '@deepseek-ai/dsh-storage-domain': StorageDomain,
    '@deepseek-ai/dsh-client-connection': Connection,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  ctx.provide('connectionTrust', Connection.createConnectionTrustContext(FORWARD_SECRET))
  return ctx
}

async function bootEntry(feishuOrigin: string, home: string, ports: Record<string, number>): Promise<Context> {
  const storages = join(home, 'storages')
  await mkdir(storages, { recursive: true })
  const configPath = join(home, 'cordis.yml')
  const rows = [
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: join(home, '.credentials.yaml'), watch: false } },
    { name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
    { name: '@deepseek-ai/dsh-storage' },
    { name: '@deepseek-ai/dsh-storage-json', config: { root: storages } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { name: '@deepseek-ai/dsh-identity-providers' },
    { id: 'identity-feishu', name: '@deepseek-ai/dsh-identity-provider-feishu', config: { id: PROVIDER_ID, appId: APP_ID, appSecret: APP_SECRET, baseUrl: feishuOrigin + '/open-apis/' } },
    { name: '@deepseek-ai/dsh-client-connection' },
  ]
  await writeFile(configPath, rows.map(r => '- ' + JSON.stringify({ ...r, name: 'cordis:' + r.name })).join('\n') + '\n')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(home).href + '/'
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
  await ctx.plugin({ name, inject: [...inject], Config, apply: applyRouteUsers }, { ports, forwardSecret: FORWARD_SECRET })
  return ctx
}

describe('end-to-end forwarding trust', () => {
  it('entry signs the caller and the hardened backend admits it', { timeout: 60_000 }, async () => {
    feishu = await startFeishu()
    root = await mkdtemp(join(tmpdir(), 'dsh-trust-'))
    backend = await startBackend()
    backendCtx = await bootBackend(join(root, 'users', 'alice'))
    const ports: Record<string, number> = {}
    ports[PROVIDER_ID + ':' + TENANT + ':' + OPEN_ID] = Number(new URL(backend.origin).port)
    const entry = await bootEntry(feishu.origin, join(root, 'entry'), ports)
    contexts = [entry, backendCtx]
    const webOrigin = 'http://127.0.0.1:' + String(entry.webServer.port)

    const login = await fetch(webOrigin + '/login?provider=' + PROVIDER_ID, { redirect: 'manual' })
    const authorization = new URL(login.headers.get('location') ?? 'http://invalid.invalid')
    const state = authorization.searchParams.get('state') ?? ''
    const callback = await fetch(webOrigin + '/login/callback?state=' + encodeURIComponent(state) + '&code=c', { redirect: 'manual' })
    const cookie = callback.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    expect(cookie).not.toBe('')

    const routed = await fetch(webOrigin + '/', { redirect: 'manual', headers: { cookie } })
    expect(routed.status).toBe(200)
    expect(await routed.text()).toBe('backend:' + OPEN_ID)

    // A request straight at the backend without the signed header is refused by the backend itself.
    if (backend === undefined) throw new Error('backend did not start')
    const direct = await fetch(backend.origin + '/', { redirect: 'manual' })
    expect(direct.status).toBe(401)
  })
})
