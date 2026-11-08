/**
 * REAL-composition coverage for Feishu login: a test-only cordis.yml booted through the vendored
 * Loader mounts the webserver, storage, identity, and connection rows beside a local Feishu mock,
 * and every assertion observes the served HTTP surface and the durable browser-session record.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import IdentityProviders from '@deepseek-ai/dsh-identity-providers'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import FeishuIdentityProvider from '../src/index.ts'

const APP_ID = 'cli_app_123'
const APP_SECRET = 'app-secret'
const PROVIDER_ID = 'feishu'
const OPEN_ID = 'ou_42'
const TENANT = 'tenant-7'

/** Read the JSON body of one request. */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** One local Feishu Open Platform mock and the token request it received. */
interface FeishuMock {
  readonly origin: string
  tokenRequests: Array<Record<string, unknown>>
  userInfoCalls: string[]
  readonly close: () => Promise<void>
}

/**
 * Start the local Feishu mock the deployment points at.
 * @returns the running mock.
 */
async function startMock(): Promise<FeishuMock> {
  const tokenRequests: Array<Record<string, unknown>> = []
  const userInfoCalls: string[] = []
  const server = createServer((request, response) => {
    if (request.url === '/open-apis/authen/v2/oauth/token' && request.method === 'POST') {
      void readJson(request).then((body) => {
        tokenRequests.push(body)
        json(response, { code: 0, data: { access_token: 'u-abc' } })
      })
      return
    }
    if (request.url === '/open-apis/authen/v1/user_info') {
      userInfoCalls.push(request.headers.authorization ?? '')
      json(response, { code: 0, data: { open_id: OPEN_ID, tenant_key: TENANT, name: 'Alice', avatar_url: 'https://img.example/a.png' } })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the Feishu mock did not bind a port')
  const origin = 'http://127.0.0.1:' + String(address.port)
  return {
    origin,
    tokenRequests,
    userInfoCalls,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    }),
  }
}

let mock: FeishuMock | undefined
let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await mock?.close()
  mock = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the real composition against one running Feishu mock.
 * @param mockOrigin - origin the deployment configures as its Feishu base URL.
 * @returns the loaded composition root.
 */
async function loadComposition(mockOrigin: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-feishu-login-'))
  const storages = join(root, 'storages')
  await mkdir(storages)
  const configPath = join(root, 'cordis.yml')
  const rows = [
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: join(root, '.credentials.yaml'), watch: false } },
    { name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
    { name: '@deepseek-ai/dsh-storage' },
    { name: '@deepseek-ai/dsh-storage-json', config: { root: storages } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { name: '@deepseek-ai/dsh-identity-providers' },
    {
      id: 'identity-feishu',
      name: '@deepseek-ai/dsh-identity-provider-feishu',
      config: {
        id: PROVIDER_ID,
        appId: APP_ID,
        appSecret: APP_SECRET,
        baseUrl: mockOrigin + '/open-apis/',
      },
    },
    { name: '@deepseek-ai/dsh-client-connection' },
  ]
  await writeFile(configPath, rows.map(row => '- ' + JSON.stringify({ ...row, name: 'cordis:' + row.name })).join('\n') + '\n')
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  Object.assign(context.loader.builtins, {
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
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

/**
 * Read every text file under one directory.
 * @param directory - root to walk.
 * @param prefix - path of `directory` inside the walk.
 * @returns the file contents, in directory order.
 */
async function readTree(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true })
  const texts: string[] = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : join(prefix, entry.name)
    if (entry.isDirectory()) texts.push(...await readTree(directory, relative))
    else texts.push(await readFile(join(directory, relative), 'utf8'))
  }
  return texts
}

/** Address of the mounted webserver. */
function origin(): string {
  if (context === undefined) throw new Error('the composition did not boot')
  return 'http://127.0.0.1:' + String(context.webServer.port)
}

describe('Feishu login over a real Loader composition', () => {
  it('authorizes at Feishu, exchanges the code, and admits the resolved user', { timeout: 30_000 }, async () => {
    mock = await startMock()
    await loadComposition(mock.origin)

    const login = await fetch(origin() + '/login?provider=' + PROVIDER_ID, { redirect: 'manual' })
    expect(login.status).toBe(303)
    const location = login.headers.get('location')
    if (location === null) throw new Error('the login route answered no authorization endpoint')
    const authorization = new URL(location)
    expect(authorization.origin).toBe(mock.origin)
    expect(authorization.pathname).toBe('/open-apis/authen/v1/authorize')
    expect(authorization.searchParams.get('app_id')).toBe(APP_ID)
    expect(authorization.searchParams.get('redirect_uri')).toBe(origin() + '/login/callback')
    const state = authorization.searchParams.get('state')
    if (state === null || state === '') throw new Error('the login route answered no state value')

    const callback = await fetch(origin() + '/login/callback?state=' + encodeURIComponent(state) + '&code=code-1', { redirect: 'manual' })
    expect(callback.status).toBe(303)
    expect(callback.headers.get('location')).toBe('../')
    const cookie = callback.headers.get('set-cookie')
    if (cookie === null) throw new Error('the callback set no browser cookie')
    const sessionCookie = cookie.split(';', 1)[0]!

    expect(mock.tokenRequests).toHaveLength(1)
    expect(mock.tokenRequests[0]).toMatchObject({ grant_type: 'authorization_code', client_id: APP_ID, client_secret: APP_SECRET, code: 'code-1', redirect_uri: origin() + '/login/callback' })
    expect(mock.userInfoCalls).toEqual(['Bearer u-abc'])

    if (root === undefined) throw new Error('the composition did not boot')
    const recorded = (await readTree(join(root, 'storages'))).join('\n')
    expect(recorded).toContain(PROVIDER_ID)
    expect(recorded).toContain(OPEN_ID)
    expect(recorded).toContain(TENANT)

    const host = new URL(origin()).host
    const admitted = context!.connection.admit({ headers: { host, cookie: sessionCookie } })
    if (!('peer' in admitted)) throw new Error('the signed-in browser was not admitted')
    expect(admitted.peer.principal.kind).toBe('user')
    if (admitted.peer.principal.kind !== 'user') throw new Error('expected a user principal')
    expect(admitted.peer.principal.providerId).toBe(PROVIDER_ID)
    expect(admitted.peer.principal.subjectId).toBe(OPEN_ID)
    expect(admitted.peer.principal.tenantId).toBe(TENANT)

    const logout = await fetch(origin() + '/logout', { redirect: 'manual', headers: { cookie: sessionCookie } })
    expect(logout.status).toBe(303)
    const afterLogout = context!.connection.admit({ headers: { host, cookie: sessionCookie } })
    expect(afterLogout).toEqual({ rejection: 401 })
  })
})
