import type { Context } from '@deepseek-ai/cordis'

const browserCookies = new WeakMap<Context, string>()

/** Provide an in-memory credential-record owner for a mounted Connection plugin. */
export function provideBrowserCredentials(ctx: Context): void {
  const records = new Map<unknown, unknown>()
  ctx.provide('credentials', {
    async modifyRecord(
      key: unknown,
      mutate: (current: unknown) => Promise<unknown>,
    ): Promise<unknown> {
      const current = records.get(key)
      const next = await mutate(current)
      if (next !== undefined) records.set(key, next)
      return next ?? current
    },
  } as never)
}

/**
 * Exchange a test Host's process token for its WebSocket/HTTP Cookie header.
 * @param ctx - Host root with the Web server and Connection mounted.
 * @returns the `cookie` header value, cached per root.
 */
export function browserCookie(ctx: Context): string {
  const existing = browserCookies.get(ctx)
  if (existing !== undefined) return existing
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const target = new URL(ctx.connection.authenticatedUrl(origin))
  let setCookie: string | undefined
  ctx.connection.authorizeIndex({
    method: 'GET',
    url: `${target.pathname}${target.search}`,
    headers: { host: target.host },
  }, {
    writeHead(_status, headers) { setCookie = headers?.['set-cookie'] },
    end() {},
  })
  if (setCookie === undefined) throw new Error('gateway fixture did not receive a browser cookie')
  const cookie = setCookie.split(';', 1)[0]!
  browserCookies.set(ctx, cookie)
  return cookie
}

/**
 * Provide an in-memory `storageDomain` for a mounted Connection plugin: its browser-session
 * records live in this table, and a test reads them back through it.
 * @param ctx - the root that mounts Connection.
 */
export function provideBrowserSessionDomain(ctx: Context): void {
  ctx.provide('storageDomain', {
    async open(): Promise<unknown> {
      const tables = new Map<string, Map<string, unknown>>()
      return {
        close: async (): Promise<void> => {},
        table(name: string) {
          const store = tables.get(name) ?? new Map<string, unknown>()
          tables.set(name, store)
          return {
            get: (key: string): unknown => store.get(key),
            entries: (): IterableIterator<[string, unknown]> => store.entries(),
            keys: (): IterableIterator<string> => store.keys(),
            get size(): number { return store.size },
            put: async (key: string, value: unknown): Promise<void> => { store.set(key, value) },
            delete: async (key: string): Promise<boolean> => store.delete(key),
            deleteMany: async (keys: readonly string[]): Promise<number> => {
              let removed = 0
              for (const key of keys) if (store.delete(key)) removed += 1
              return removed
            },
            update: async (key: string, next: (current: unknown) => unknown): Promise<unknown> => {
              const value = next(store.get(key))
              store.set(key, value)
              return value
            },
          }
        },
      }
    },
  } as never)
}
