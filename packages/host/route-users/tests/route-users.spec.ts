/**
 * REAL routing through the identity-aware proxy: one backend serves one person, and every
 * request the admitter recognizes is forwarded there with the entry host rewritten off the wire.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { proxyRequest } from '../src/index.ts'
import { userPrincipal, type UserPrincipal } from '@deepseek-ai/dsh-user-principal'

/** The fixture caller the admitter returns. */
const USER: UserPrincipal = (() => {
  const user = userPrincipal({ providerId: 'feishu', tenantId: 'tenant-7', subjectId: 'ou_42', displayName: 'Alice' })
  if (user === undefined) throw new Error('fixture identity is empty')
  return user
})()

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((e) => { if (e === undefined) resolve(); else reject(e) })
  })
}

/** Start a one-shot backend and report every request it saw. */
interface Backend {
  readonly origin: string
  readonly requests: Array<{ method: string; path: string; host: string }>
  readonly close: () => Promise<void>
}

async function startBackend(body: string): Promise<Backend> {
  const requests: Array<{ method: string; path: string; host: string }> = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? '', path: request.url ?? '', host: request.headers.host ?? '' })
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('backend did not bind a port')
  const origin = 'http://127.0.0.1:' + String(address.port)
  const close = (): Promise<void> => closeServer(server)
  return { origin, requests, close }
}

/** Start an entry server that proxies every request through the given routing. */
interface Entry {
  readonly origin: string
  readonly close: () => Promise<void>
}

async function startEntry(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Entry> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('entry did not bind a port')
  const origin = 'http://127.0.0.1:' + String(address.port)
  const close = (): Promise<void> => closeServer(server)
  return { origin, close }
}

let backend: Backend | undefined
let entry: Entry | undefined

afterEach(async () => {
  await entry?.close()
  await backend?.close()
  entry = undefined
  backend = undefined
})

describe('identity-aware reverse proxy', () => {
  it('forwards an admitted request to its user backend and rewrites host', async () => {
    backend = await startBackend('alice-body')
    const resolver = (userKey: string): string | undefined => userKey === 'feishu:tenant-7:ou_42' ? backend!.origin : undefined
    const admit = (request: IncomingMessage): UserPrincipal | undefined => request.headers.cookie === 'alice' ? USER : undefined
    entry = await startEntry((request, response) => { proxyRequest(request, response, resolver, admit) })

    const received = await fetch(entry.origin + '/some/path', { headers: { cookie: 'alice', 'x-forwarded-extra': 'yes' } })
    expect(received.status).toBe(200)
    expect(await received.text()).toBe('alice-body')
    expect(backend.requests).toHaveLength(1)
    expect(backend.requests[0]).toMatchObject({ method: 'GET', path: '/some/path' })
    expect(backend.requests[0]!.host).toBe(new URL(backend.origin).host)
  })

  it('refuses an unadmitted request with 401 and no backend call', async () => {
    backend = await startBackend('never')
    const resolver = (): string | undefined => backend!.origin
    const admit = (): UserPrincipal | undefined => undefined
    entry = await startEntry((request, response) => { proxyRequest(request, response, resolver, admit) })

    const received = await fetch(entry.origin + '/', { redirect: 'manual' })
    expect(received.status).toBe(401)
    expect(backend.requests).toHaveLength(0)
  })

  it('refuses a user with no backend with 502', async () => {
    backend = await startBackend('never')
    const resolver = (): string | undefined => undefined
    const admit = (): UserPrincipal | undefined => USER
    entry = await startEntry((request, response) => { proxyRequest(request, response, resolver, admit) })

    const received = await fetch(entry.origin + '/', { redirect: 'manual' })
    expect(received.status).toBe(502)
    expect(backend.requests).toHaveLength(0)
  })

  it('drops hop-by-hop headers from the forwarded request', async () => {
    backend = await startBackend('clean')
    const resolver = (): string | undefined => backend!.origin
    const admit = (): UserPrincipal | undefined => USER
    entry = await startEntry((request, response) => { proxyRequest(request, response, resolver, admit) })

    const received = await fetch(entry.origin + '/', { headers: { connection: 'keep-alive', 'proxy-authorization': 'x', cookie: 'alice' } })
    expect(received.status).toBe(200)
  })
})
