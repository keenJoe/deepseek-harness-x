/**
 * REAL-composition coverage for hosted browser login: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver, storage, identity, and connection rows beside a local
 * OpenID Connect issuer, and every assertion observes the served HTTP surface and the durable
 * browser-session record this Host wrote.
 */

import { Buffer } from 'node:buffer'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
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
import OidcIdentityProvider from '../src/index.ts'

const CLIENT_ID = 'client-id'
const PROVIDER_ID = 'fixture'
const SUBJECT = 'user-42'
const TENANT = 'acme'

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicJwk = keyPair.publicKey.export({ format: 'jwk' })
if (publicJwk.n === undefined || publicJwk.e === undefined) throw new Error('the fixture RSA key published no modulus or exponent')

/**
 * Encode text or bytes as unpadded base64url.
 * @param value - text or raw bytes.
 * @returns the unpadded base64url encoding.
 */
function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

/**
 * Sign one id_token the fixture issuer returns for a successful code exchange.
 * @param issuer - issuer identifier every token and the deployment agree on.
 * @returns a compact RS256 JWS carrying the fixture claims.
 */
function mintIdToken(issuer: string): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', kid: 'key-1', typ: 'JWT' }))
  const issuedAt = Math.floor(Date.now() / 1000)
  const payload = base64url(JSON.stringify({
    iss: issuer,
    aud: CLIENT_ID,
    sub: SUBJECT,
    iat: issuedAt,
    exp: issuedAt + 600,
    preferred_username: 'Alice',
    tid: TENANT,
  }))
  const signature = base64url(sign('sha256', Buffer.from(header + '.' + payload), keyPair.privateKey))
  return header + '.' + payload + '.' + signature
}

/** One local issuer and the token requests it received. */
interface Issuer {
  /** Origin every configured endpoint sits under. */
  readonly origin: string
  /** Form bodies of the token requests the provider sent, in arrival order. */
  readonly tokenRequests: URLSearchParams[]
  /** Stop listening and release the port. */
  readonly close: () => Promise<void>
}

/**
 * Start the local issuer the deployment points at.
 * @returns the running issuer.
 */
async function startIssuer(): Promise<Issuer> {
  const tokenRequests: URLSearchParams[] = []
  const server = createServer((request, response) => {
    if (request.url === '/jwks') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ keys: [{ kty: 'RSA', kid: 'key-1', n: publicJwk.n, e: publicJwk.e, use: 'sig' }] }))
      return
    }
    if (request.url === '/token' && request.method === 'POST') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        tokenRequests.push(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ access_token: 'access-token', token_type: 'Bearer', id_token: mintIdToken(origin) }))
      })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the fixture issuer did not bind a port')
  const origin = 'http://127.0.0.1:' + String(address.port)
  return {
    origin,
    tokenRequests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    }),
  }
}

let issuer: Issuer | undefined
let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await issuer?.close()
  issuer = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the real composition against one running issuer.
 * @param issuerOrigin - origin the deployment configures as its issuer and endpoints.
 * @returns the loaded composition root.
 */
async function loadComposition(issuerOrigin: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-oidc-login-'))
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
      id: 'identity-oidc',
      name: '@deepseek-ai/dsh-identity-provider-oidc',
      config: {
        id: PROVIDER_ID,
        issuer: issuerOrigin,
        clientId: CLIENT_ID,
        scopes: ['openid', 'profile', 'email'],
        authorizationEndpoint: issuerOrigin + '/authorize',
        tokenEndpoint: issuerOrigin + '/token',
        jwksUri: issuerOrigin + '/jwks',
        defaultTenant: TENANT,
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
    '@deepseek-ai/dsh-identity-provider-oidc': OidcIdentityProvider,
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

describe('hosted browser login over a real Loader composition', () => {
  it('authenticates a browser through the OIDC adapter and revokes it on logout', { timeout: 30_000 }, async () => {
    issuer = await startIssuer()
    await loadComposition(issuer.origin)

    const login = await fetch(origin() + '/login?provider=' + PROVIDER_ID, { redirect: 'manual' })
    expect(login.status).toBe(303)
    const location = login.headers.get('location')
    if (location === null) throw new Error('the login route answered no authorization endpoint')
    const authorization = new URL(location)
    expect(authorization.origin).toBe(issuer.origin)
    expect(authorization.pathname).toBe('/authorize')
    expect(authorization.searchParams.get('response_type')).toBe('code')
    expect(authorization.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(authorization.searchParams.get('redirect_uri')).toBe(origin() + '/login/callback')
    expect(authorization.searchParams.get('scope')).toBe('openid profile email')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    const state = authorization.searchParams.get('state')
    if (state === null || state === '') throw new Error('the login route answered no state value')
    expect(authorization.searchParams.get('code_challenge')).not.toBeNull()

    const callback = await fetch(origin() + '/login/callback?state=' + encodeURIComponent(state) + '&code=code-1', { redirect: 'manual' })
    expect(callback.status).toBe(303)
    expect(callback.headers.get('location')).toBe('../')
    const cookie = callback.headers.get('set-cookie')
    if (cookie === null) throw new Error('the callback set no browser cookie')
    const sessionCookie = cookie.split(';', 1)[0]!

    expect(issuer.tokenRequests).toHaveLength(1)
    const exchanged = issuer.tokenRequests[0]!
    expect(exchanged.get('grant_type')).toBe('authorization_code')
    expect(exchanged.get('code')).toBe('code-1')
    expect(exchanged.get('redirect_uri')).toBe(origin() + '/login/callback')
    expect(exchanged.get('code_verifier')).not.toBeNull()

    if (root === undefined) throw new Error('the composition did not boot')
    const recorded = (await readTree(join(root, 'storages'))).join('\n')
    expect(recorded).toContain(PROVIDER_ID)
    expect(recorded).toContain(SUBJECT)
    expect(recorded).toContain(TENANT)

    const host = new URL(origin()).host
    const admitted = context!.connection.admit({ headers: { host, cookie: sessionCookie } })
    if (!('peer' in admitted)) throw new Error('the signed-in browser was not admitted')
    expect(admitted.peer.principal.kind).toBe('user')

    const anonymous = context!.connection.admit({ headers: { host } })
    expect(anonymous).toEqual({ rejection: 401 })

    const logout = await fetch(origin() + '/logout', { redirect: 'manual', headers: { cookie: sessionCookie } })
    expect(logout.status).toBe(303)

    const afterLogout = context!.connection.admit({ headers: { host, cookie: sessionCookie } })
    expect(afterLogout).toEqual({ rejection: 401 })
  })

  it('refuses a replayed callback state', { timeout: 30_000 }, async () => {
    issuer = await startIssuer()
    await loadComposition(issuer.origin)

    const login = await fetch(origin() + '/login?provider=' + PROVIDER_ID, { redirect: 'manual' })
    const authorization = new URL(login.headers.get('location') ?? 'http://invalid.invalid')
    const state = authorization.searchParams.get('state') ?? ''

    const first = await fetch(origin() + '/login/callback?state=' + encodeURIComponent(state) + '&code=code-1', { redirect: 'manual' })
    expect(first.status).toBe(303)
    const replay = await fetch(origin() + '/login/callback?state=' + encodeURIComponent(state) + '&code=code-1', { redirect: 'manual' })
    expect(replay.status).toBe(401)
    expect(replay.headers.get('set-cookie')).toBeNull()
  })
})
