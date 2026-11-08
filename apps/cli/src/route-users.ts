/**
 * Assemble hosted multi-user Web: one identity-routing entry plus one harness instance per person.
 *
 * The entry owns the Feishu login and the `route-users` fallback; every person’s backend owns its
 * harness home and mounts `route-users-backend` to verify the entry-signed caller. The entry patch
 * carries the Feishu app id/secret and the route-users port table (keyed by canonical user id), the
 * user patch carries the backend trust plugin, and one shared forward secret flows to both halves
 * through the environment.
 * @module @deepseek-ai/dsh/route-users
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { resolveDshHome, USERS_DIR_NAME } from '@deepseek-ai/dsh-home-paths'
import { planUserInstances } from './serve-users.ts'

/** First port the entry listens on; each backend takes the next port after it. */
export const DEFAULT_ENTRY_PORT = 3080

/** One planned supervised process: the entry or one person’s backend. */
export interface RouteUsersPlan {
  /** Process label for logs: `entry` or a user key. */
  readonly key: string
  /** Absolute harness home this process owns. */
  readonly home: string
  /** Loopback port it listens on. */
  readonly port: number
  /** Full child argv, entry executable first. */
  readonly argv: readonly string[]
  /** Environment the child inherits, with its own DSH_HOME. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Everything the launcher needs to assemble the entry and the per-person backends. */
export interface RouteUsersOptions {
  /** Profile every process boots. */
  readonly profile: string
  /** One key per person, in launch order. */
  readonly users: readonly string[]
  /** Directory holding one home per key and the entry home; defaults to the harness users directory. */
  readonly usersRoot?: string | undefined
  /** Feishu tenant key; together with each `users` entry it forms the canonical `feishu:<tenant>:<subject>` route key. */
  readonly tenant?: string | undefined
  /** Port the entry takes; defaults to {@link DEFAULT_ENTRY_PORT}. */
  readonly entryPort?: number | undefined
  /** Port the first backend takes; defaults to the entry port plus one. */
  readonly basePort?: number | undefined
  /** Patch overlays applied only to the entry (Feishu login + route-users port table). */
  readonly entryPatches?: readonly string[] | undefined
  /** Patch overlays applied to every backend (route-users-backend trust). */
  readonly userPatches?: readonly string[] | undefined
  /** Shared forwarding secret; exported to every child as `DSH_FORWARD_SECRET`. */
  readonly forwardSecret?: string | undefined
  /** Arguments forwarded to every child app after its launcher flags. */
  readonly appArgs?: readonly string[] | undefined
  /** Child entry command, defaults to this process launcher. */
  readonly entry?: readonly string[] | undefined
  /** Node flags every child inherits; defaults to this process execArgv. */
  readonly execArgv?: readonly string[] | undefined
}

/**
 * Compute the entry plan and the per-person backend plans.
 * @param options - profile, people, ports, and the entry/user overlays.
 * @returns the entry plan followed by one plan per person, in launch order.
 */
export function planRouteUsers(options: RouteUsersOptions): RouteUsersPlan[] {
  const usersRoot = resolve(options.usersRoot ?? join(resolveDshHome(), USERS_DIR_NAME))
  const entryPort = options.entryPort ?? DEFAULT_ENTRY_PORT
  if (!Number.isSafeInteger(entryPort) || entryPort < 1 || entryPort > 65_535) {
    throw new Error('route-users: --entry-port must be a port number from 1 through 65535')
  }
  const backendPlans = planUserInstances({
    profile: options.profile,
    users: options.users,
    usersRoot,
    basePort: options.basePort ?? entryPort + 1,
    patchFiles: options.userPatches,
    appArgs: options.appArgs,
    entry: options.entry,
    execArgv: options.execArgv,
  })
  const [executable = process.execPath, ...entryArgs] = options.entry ?? [process.execPath, process.argv[1] ?? 'dsh']
  const execArgv = options.execArgv ?? process.execArgv
  const entryHome = join(usersRoot, 'entry')
  const portsOverlay = join(entryHome, 'route-users.ports.yml')
  const entryPlan: RouteUsersPlan = {
    key: 'entry',
    home: entryHome,
    port: entryPort,
    argv: [
      executable,
      ...execArgv,
      ...entryArgs,
      '--profile', options.profile,
      ...(options.entryPatches ?? []).flatMap(file => ['--patch', file]),
      '--patch', portsOverlay,
      '--port', String(entryPort),
      ...(options.appArgs ?? []),
    ],
    env: { ...process.env, DSH_HOME: entryHome },
  }
  return [entryPlan, ...backendPlans]
}

/**
 * Build the entry router’s canonical user key to backend port mapping.
 * @param users - one Feishu subject (open_id) per person, in launch order.
 * @param tenant - Feishu tenant key; defaults to `default`.
 * @param basePort - the first backend port; each later subject adds one.
 * @returns `feishu:<tenant>:<subject>` to loopback port mapping.
 */
export function buildRouteUsersPorts(
  users: readonly string[],
  tenant: string,
  basePort: number,
): Record<string, number> {
  const ports: Record<string, number> = {}
  users.forEach((subject, index) => {
    ports['feishu:' + tenant + ':' + subject] = basePort + index
  })
  return ports
}

/**
 * Render the entry overlay enabling `route-users` with the computed ports table.
 * @param ports - canonical user key to backend port mapping.
 * @returns a YAML patch-list document the entry applies after its Feishu login overlay.
 */
export function renderEntryPortsOverlay(ports: Readonly<Record<string, number>>): string {
  const rows = Object.entries(ports).map(([key, port]) => "      '" + key + "': " + String(port))
  const portsBlock = rows.length > 0 ? rows.join('\n') + '\n' : '    {}\n'
  return '- id: route-users\n  disabled: false\n  config:\n    ports:\n' + portsBlock
    + '    forwardSecret: !!js process.env.DSH_FORWARD_SECRET\n'
}

/** Runtime the launcher supplies around one assembly run. */
export interface RouteUsersRuntime {
  /** Termination request; the launcher aborts it on SIGINT or SIGTERM. */
  readonly signal?: AbortSignal | undefined
  /** Line sink for instance URLs and failures; defaults to stderr. */
  readonly log?: ((line: string) => void) | undefined
  /** Child factory; defaults to starting the planned command. */
  readonly spawnInstance?: ((plan: RouteUsersPlan) => ChildProcess) | undefined
  /** Grace period between SIGTERM and SIGKILL. */
  readonly shutdownGraceMs?: number | undefined
}

function spawnPlanned(plan: RouteUsersPlan): ChildProcess {
  const command = plan.argv[0] ?? process.execPath
  return spawn(command, plan.argv.slice(1), { env: plan.env, stdio: 'inherit' })
}

function onceExited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit) => {
    child.once('exit', (code, signal) => { resolveExit({ code, signal }) })
  })
}

/**
 * Start the entry and every backend, and keep them alive together.
 * @param options - validated launcher options.
 * @param runtime - termination signal, log sink, child factory, and grace period.
 * @returns the launcher exit code: zero after an orderly shutdown, otherwise a failure code.
 */
export async function runRouteUsers(options: RouteUsersOptions, runtime: RouteUsersRuntime = {}): Promise<number> {
  if (options.forwardSecret !== undefined) process.env.DSH_FORWARD_SECRET = options.forwardSecret
  const plans = planRouteUsers(options)
  const log = runtime.log ?? ((line: string) => { process.stderr.write(line + '\n') })
  const spawnInstance = runtime.spawnInstance ?? spawnPlanned
  const grace = runtime.shutdownGraceMs ?? 5_000
  for (const plan of plans) await mkdir(plan.home, { recursive: true, mode: 0o700 })
  const entryHome = plans.find(plan => plan.key === 'entry')?.home
  if (entryHome === undefined) throw new Error('route-users: entry plan is missing')
  const tenant = options.tenant ?? 'default'
  const ports = buildRouteUsersPorts(options.users, tenant, options.basePort ?? (options.entryPort ?? DEFAULT_ENTRY_PORT) + 1)
  await writeFile(join(entryHome, 'route-users.ports.yml'), renderEntryPortsOverlay(ports))
  const children = new Map<string, ChildProcess>()
  for (const plan of plans) {
    const child = spawnInstance(plan)
    children.set(plan.key, child)
    const kind = plan.key === 'entry' ? 'entry' : 'user ' + plan.key
    log('route-users: ' + kind + ' -> http://127.0.0.1:' + String(plan.port) + ' (home ' + plan.home + ')')
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
        if (stopping) {
          if (remaining === 0) resolveExit(failure ?? 0)
          return
        }
        failure ??= code === 0 ? 1 : (code ?? 1)
        log('route-users: ' + key + ' exited unexpectedly (' + (signal ?? String(code)) + '); stopping every process')
        shutdown(failure)
      })
    }
  })
}
