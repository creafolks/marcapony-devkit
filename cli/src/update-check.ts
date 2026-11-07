import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLI_VERSION, userAgent } from './client-info.js'
import { configDir } from './login-store.js'

/**
 * The CLI's own update check: at most once a day it asks the npm registry for
 * the latest `marcapony`, and when this CLI is behind it prints one line on
 * stderr after the command's output. It never runs with --json, in CI, under
 * a test runner, or with MARCAPONY_NO_UPDATE_CHECK=1, and it never fails or
 * slows a command by more than its timeout.
 */

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const UPDATE_CHECK_TIMEOUT_MS = 1500
export const UPDATE_COMMAND = 'bun add -g marcapony@latest'
const REGISTRY_URL = 'https://registry.npmjs.org/marcapony/latest'
const CACHE_FILE = 'update-check.json'

interface CachedCheck {
  checkedAt: string
  latest: string | null
}

export interface UpdateCheckOptions {
  env?: NodeJS.ProcessEnv
  json?: boolean
  now?: () => Date
  fetchImpl?: typeof fetch
  /** Where the cache lives; the user config directory, next to the login. */
  dir?: string
  current?: string
}

export function updateCheckEnabled(env: NodeJS.ProcessEnv, json: boolean): boolean {
  if (json) return false
  if (env.MARCAPONY_NO_UPDATE_CHECK === '1') return false
  if (env.CI && env.CI !== '0' && env.CI.toLowerCase() !== 'false') return false
  if (env.NODE_ENV === 'test') return false
  return true
}

/** `[major, minor, patch]` of a plain version; prerelease and build parts are dropped. */
export function parseVersion(value: string | null | undefined): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec((value ?? '').trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** True when `current` is older than `latest`; false when either cannot be read. */
export function isBehind(current: string, latest: string): boolean {
  const a = parseVersion(current)
  const b = parseVersion(latest)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!
  }
  return false
}

function readCache(dir: string): CachedCheck | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, CACHE_FILE), 'utf8')) as Partial<CachedCheck>
    if (typeof parsed.checkedAt !== 'string') return null
    return {
      checkedAt: parsed.checkedAt,
      latest: typeof parsed.latest === 'string' ? parsed.latest : null,
    }
  } catch {
    return null
  }
}

function writeCache(dir: string, check: CachedCheck): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, CACHE_FILE), `${JSON.stringify(check)}\n`)
  } catch {
    // A read-only home only means the check runs again next time.
  }
}

async function fetchLatest(fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(REGISTRY_URL, {
      headers: { Accept: 'application/json', 'User-Agent': userAgent() },
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    return typeof body.version === 'string' && parseVersion(body.version) ? body.version : null
  } catch {
    return null
  }
}

/**
 * The latest CLI version, from the day's cached answer or the registry. A
 * failed lookup is cached too, so an offline machine is not asked every run.
 * Null when the check is off or nothing is known.
 */
export async function latestCliVersion(options: UpdateCheckOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env
  if (!updateCheckEnabled(env, options.json === true)) return null
  const dir = options.dir ?? configDir(env)
  const now = options.now?.() ?? new Date()
  const cached = readCache(dir)
  const age = cached ? now.getTime() - new Date(cached.checkedAt).getTime() : Number.NaN
  if (cached && age >= 0 && age < UPDATE_CHECK_INTERVAL_MS) return cached.latest
  const latest = await fetchLatest(options.fetchImpl ?? globalThis.fetch)
  writeCache(dir, { checkedAt: now.toISOString(), latest: latest ?? cached?.latest ?? null })
  return latest ?? cached?.latest ?? null
}

/** The line to print when this CLI is behind, or null. */
export function updateLine(current: string, latest: string | null): string | null {
  if (!latest || !isBehind(current, latest)) return null
  return `Marcapony CLI ${latest} is available (you have ${current}): ${UPDATE_COMMAND}`
}

/**
 * Start the check when the command starts, so the registry answer arrives
 * while the command runs. The returned function waits for it and prints.
 */
export function startUpdateCheck(
  options: UpdateCheckOptions & { print?: (line: string) => void } = {},
): (alreadyNotified: boolean) => Promise<void> {
  const pending = latestCliVersion(options).catch(() => null)
  return async (alreadyNotified) => {
    const latest = await pending
    if (alreadyNotified) return
    const line = updateLine(options.current ?? CLI_VERSION, latest)
    if (line) (options.print ?? ((text: string) => console.error(text)))(line)
  }
}

let serverNotified = false

/** The platform already told this run about a newer CLI; the own line is not repeated. */
export function noteServerCliNotice(): void {
  serverNotified = true
}

export function serverCliNoticeSeen(): boolean {
  return serverNotified
}
