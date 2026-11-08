/**
 * Supervise one DeepSeek Harness instance per person.
 *
 * A harness process owns one home and serves one caller identity, so serving several people
 * means running one instance per person, each with its own DSH_HOME and port. This module
 * computes that layout and keeps the children alive together: it creates each home, starts
 * the same profile against it, reports each instance URL, and tears every child down when one
 * of them fails or the launcher receives a termination signal.
 * @module @deepseek-ai/dsh/serve-users
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { resolveDshHome, USERS_DIR_NAME } from '@deepseek-ai/dsh-home-paths'

/** First port a supervised instance asks for; every further instance adds one. */
export const DEFAULT_USER_BASE_PORT = 3080

/** How long a child may ignore SIGTERM before the launcher kills it. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000

/** A user key becomes one directory name, so it admits only portable path segments. */
const USER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** One planned per-person instance. */
export interface UserInstancePlan {
  /** Person this instance serves; also its directory name under the users root. */
  readonly key: string
  /** Absolute harness home the child owns. */
  readonly home: string
  /** Loopback port the child listens on. */
  readonly port: number
  /** Full child argv, entry executable first. */
  readonly argv: readonly string[]
  /** Environment the child inherits, with its own DSH_HOME. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Everything the launcher needs to supervise several people. */
export interface ServeUsersOptions {
  /** Profile every child boots. */
  readonly profile: string
  /** One key per person, in launch order. */
  readonly users: readonly string[]
  /** Directory holding one home per key; defaults to the harness home users directory. */
  readonly usersRoot?: string | undefined
  /** Port the first instance takes; later instances add one each. */
  readonly basePort?: number | undefined
  /** Extra patch overlays applied by every child, in argv order. */
  readonly patchFiles?: readonly string[] | undefined
  /** Arguments forwarded to every child app after its launcher flags. */
  readonly appArgs?: readonly string[] | undefined
  /** Child entry command, defaults to this process launcher. */
  readonly entry?: readonly string[] | undefined
  /** Node flags every child inherits; defaults to this process execArgv. */
  readonly execArgv?: readonly string[] | undefined
}

/**
 * Compute the instance layout for one serve-users invocation.
 * @param options - profile, people, and the overrides the launcher accepted.
 * @returns one plan per person, in launch order.
 * @throws when a key is not a portable directory name, repeats, or names no person.
 */
export function planUserInstances(options: ServeUsersOptions): UserInstancePlan[] {
  const keys = options.users.map(key => key.trim()).filter(key => key.length > 0)
  if (keys.length === 0) throw new Error('serve-users: at least one --users value is required')
  const seen = new Set<string>()
  for (const key of keys) {
    if (!USER_KEY_PATTERN.test(key)) {
      throw new Error(
        'serve-users: ' + JSON.stringify(key) + ' is not a usable user key (letters, digits, dot, dash, underscore)',
      )
    }
    if (seen.has(key)) throw new Error('serve-users: user ' + JSON.stringify(key) + ' is listed twice')
    seen.add(key)
  }
  const usersRoot = resolve(options.usersRoot ?? join(resolveDshHome(), USERS_DIR_NAME))
  const basePort = options.basePort ?? DEFAULT_USER_BASE_PORT
  if (!Number.isSafeInteger(basePort) || basePort < 1 || basePort + keys.length - 1 > 65_535) {
    throw new Error('serve-users: --port must be a port number that leaves room for every instance')
  }
  const entry = options.entry ?? [process.execPath, process.argv[1] ?? 'dsh']
  // A source launch runs through a loader flag, and every child needs it too.
  const execArgv = options.execArgv ?? process.execArgv
  const [executable, ...entryArgs] = entry
  return keys.map((key, index) => {
    const port = basePort + index
    const home = join(usersRoot, key)
    const argv = [
      executable ?? process.execPath,
      ...execArgv,
      ...entryArgs,
      '--profile', options.profile,
      ...(options.patchFiles ?? []).flatMap(file => ['--patch', file]),
      '--port', String(port),
      ...(options.appArgs ?? []),
    ]
    return { key, home, port, argv, env: { ...process.env, DSH_HOME: home } }
  })
}

/** Injected child factory, so a test can supervise a script instead of a harness. */
export type SpawnUserInstance = (plan: UserInstancePlan) => ChildProcess

/** Runtime the launcher supplies around one supervision run. */
export interface ServeUsersRuntime {
  /** Termination request; the launcher aborts it on SIGINT or SIGTERM. */
  readonly signal?: AbortSignal | undefined
  /** Line sink for instance URLs and failures; defaults to stderr. */
  readonly log?: ((line: string) => void) | undefined
  /** Child factory; defaults to starting the planned command. */
  readonly spawnInstance?: SpawnUserInstance | undefined
  /** Grace period between SIGTERM and SIGKILL. */
  readonly shutdownGraceMs?: number | undefined
}

function defaultSpawn(plan: UserInstancePlan): ChildProcess {
  const command = plan.argv[0] ?? process.execPath
  return spawn(command, plan.argv.slice(1), { env: plan.env, stdio: 'inherit' })
}

function onceExited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit) => {
    child.once('exit', (code, signal) => { resolveExit({ code, signal }) })
  })
}

/**
 * Start one instance per person and keep them alive together.
 * @param options - validated launcher options.
 * @param runtime - termination signal, log sink, child factory, and grace period.
 * @returns the launcher exit code: zero after an orderly shutdown, otherwise a failure code.
 */
export async function runServeUsers(options: ServeUsersOptions, runtime: ServeUsersRuntime = {}): Promise<number> {
  const plans = planUserInstances(options)
  const log = runtime.log ?? ((line: string) => { process.stderr.write(line + '\n') })
  const spawnInstance = runtime.spawnInstance ?? defaultSpawn
  const grace = runtime.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS
  for (const plan of plans) await mkdir(plan.home, { recursive: true, mode: 0o700 })
  const children = new Map<string, ChildProcess>()
  for (const plan of plans) {
    const child = spawnInstance(plan)
    children.set(plan.key, child)
    log('serve-users: ' + plan.key + ' -> http://127.0.0.1:' + String(plan.port) + ' (home ' + plan.home + ')')
  }
  const stop = async (): Promise<void> => {
    const live = [...children.values()].filter(child => child.exitCode === null && child.signalCode === null)
    for (const child of live) child.kill('SIGTERM')
    const timer = setTimeout(() => { for (const child of live) child.kill('SIGKILL') }, grace)
    await Promise.all(live.map(child => onceExited(child)))
    clearTimeout(timer)
  }
  return await new Promise<number>((resolveExit) => {
    let remaining = plans.length
    let failure: number | undefined
    let stopping = false
    const shutdown = (code: number): void => {
      if (stopping) return
      stopping = true
      void stop().then(() => { resolveExit(code) })
    }
    runtime.signal?.addEventListener('abort', () => { shutdown(0) }, { once: true })
    for (const [key, child] of children) {
      void onceExited(child).then(({ code, signal }) => {
        remaining -= 1
        // An exit after the launcher asked everyone to stop is the expected one,
        // whether the child honoured SIGTERM with a code or died from the signal.
        if (stopping) {
          if (remaining === 0) resolveExit(failure ?? 0)
          return
        }
        failure ??= code === 0 ? 1 : (code ?? 1)
        log('serve-users: ' + key + ' exited unexpectedly (' + (signal ?? String(code)) + '); stopping every instance')
        shutdown(failure)
      })
    }
  })
}
