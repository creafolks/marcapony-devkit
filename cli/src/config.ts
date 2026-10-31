import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `marcapony.json` — the project's link to its Marcapony app. Written by
 * `marcapony app link`, read by `marcapony app deploy`. Deliberately small:
 * which app, how to build, and what to upload.
 */
export interface MarcaponyConfig {
  /** App slug, as issued by the platform. */
  app: string
  /** Build command run before bundling (e.g. `bun run build`). */
  build: string
  /** Path to the built ES module worker entry. */
  worker: string
  /** Optional directory of static assets served alongside the worker. */
  assets?: string
  /** Passed through to the platform as the Workers assets config. */
  assetsConfig?: Record<string, unknown>
  compatibilityDate?: string
  compatibilityFlags?: string[]
  /**
   * Where the app lives: `portal` (behind the customer portal login, receives a
   * signed identity) or `public`. Omitted leaves the stored placement alone; a
   * deploy can move an app into the portal but never out of it.
   */
  placement?: 'portal' | 'public'
  /**
   * Whose data the app works with. On the site: `account` (every customer's
   * records, for integrations and back-office tools) or `visitor` (catalog,
   * bookings and form entries only). In the portal: `customer` (signed-in
   * customers, `me.*`) or `team` (team members). A deploy can only narrow it,
   * or pick `customer` / `team` when it moves the app into the portal; widening
   * is done in the dashboard. Omitted leaves the stored value alone.
   */
  dataAccess?: 'account' | 'visitor' | 'customer' | 'team'
  /**
   * The permissions the app offers; the owner picks who gets which in the
   * dashboard. `grants` names platform permissions (customer apps:
   * `reservations.own.read`, `reservations.own.create`, `reservations.own.cancel`,
   * `orders.own.read`, `profile.own.read`, `payment-links.own.read`,
   * `forms.own.read`; team tools: `reservations.read`, `reservations.write`,
   * `orders.read`, `customers.read`) or is empty for a permission only the app
   * interprets.
   */
  permissions?: Array<{ id: string; label: string; grants?: string[] }>
  /**
   * How a portal app appears in the portal's menu: its title (defaults to the
   * app name), an icon name and its position. Also editable on the app's page
   * in the dashboard; a deploy that carries it overwrites that.
   */
  portal?: { title?: string; icon?: string; sortOrder?: number }
}

export const CONFIG_FILE = 'marcapony.json'
export const ENV_FILE = '.dev.vars'
export const GITIGNORE_FILE = '.gitignore'

/**
 * The CLI targets one of a fixed set of known API roots. Production is the
 * default; the hidden `--cli-env` flag lets the Marcapony team point at staging
 * or local for testing. There is deliberately no way to pass an arbitrary URL —
 * an end user can only ever reach production.
 */
const API_ROOTS = {
  production: 'https://api.marcapony.com',
  staging: 'https://staging-api.marcapony.com',
  local: 'http://localhost:4000',
} as const

export type CliEnv = keyof typeof API_ROOTS
const DEFAULT_CLI_ENV: CliEnv = 'production'

export function resolveApiRoot(cliEnv?: string): string {
  const name = (cliEnv ?? DEFAULT_CLI_ENV) as CliEnv
  const root = API_ROOTS[name]
  if (!root) {
    throw new Error(
      `Unknown environment "${cliEnv}". Expected one of: ${Object.keys(API_ROOTS).join(', ')}.`,
    )
  }
  return root
}

export function parseEnvLines(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

/**
 * Update-or-append each key, preserving surrounding lines and comments — a
 * project's `.dev.vars` holds far more than our two entries.
 */
export function upsertEnvLines(content: string, updates: Record<string, string>): string {
  const lines = content.length > 0 ? content.split('\n') : []
  const remaining = { ...updates }

  const updated = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    const eq = trimmed.indexOf('=')
    if (eq <= 0) return line
    const key = trimmed.slice(0, eq).trim()
    if (key in remaining) {
      const value = remaining[key]!
      delete remaining[key]
      return `${key}=${value}`
    }
    return line
  })

  const appended = Object.entries(remaining).map(([k, v]) => `${k}=${v}`)
  if (appended.length === 0) return updated.join('\n')

  const body = updated.join('\n')
  const separator = body.length === 0 || body.endsWith('\n') ? '' : '\n'
  return `${body}${separator}${appended.join('\n')}\n`
}

export function readConfig(cwd: string): MarcaponyConfig | null {
  const path = join(cwd, CONFIG_FILE)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as MarcaponyConfig
}

export function writeConfig(cwd: string, config: MarcaponyConfig): void {
  writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`)
}

export function readEnvFile(cwd: string): string {
  const path = join(cwd, ENV_FILE)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

export function writeEnvFile(cwd: string, content: string): void {
  writeFileSync(join(cwd, ENV_FILE), content)
}

/**
 * `.dev.vars` holds a live key with the app's data scopes plus apps:deploy, and
 * `marcapony app link` can run in any project — including one whose .gitignore
 * never heard of the file. Committing it publishes the tenant's credential, so
 * ignore it before the key is written rather than trusting a scaffold to have
 * done it. Returns true when this call added the entry.
 */
export function ensureEnvFileIgnored(cwd: string): boolean {
  const path = join(cwd, GITIGNORE_FILE)
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const alreadyIgnored = current
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === ENV_FILE || line === `/${ENV_FILE}`)
  if (alreadyIgnored) return false

  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n'
  writeFileSync(path, `${current}${separator}${ENV_FILE}\n`)
  return true
}

/**
 * The deploy credential: an exported env var wins (CI), otherwise the key
 * `marcapony app link` wrote into `.dev.vars`.
 */
export function resolveApiKey(cwd: string, env: NodeJS.ProcessEnv): string | null {
  if (env.MARCAPONY_API_KEY) return env.MARCAPONY_API_KEY
  return parseEnvLines(readEnvFile(cwd)).MARCAPONY_API_KEY ?? null
}

/**
 * Best-effort defaults for a fresh link: the worker entry from a wrangler
 * config when one exists (it is dev plumbing here, never a deploy path), and
 * `dist/client` as the assets dir when present.
 */
export function detectDefaults(cwd: string): { worker: string; assets?: string } {
  let worker = 'dist/index.js'
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    const path = join(cwd, name)
    if (!existsSync(path)) continue
    // Line-scan rather than parse: wrangler.jsonc allows comments and trailing
    // commas, and a config read must never be the thing that fails a link.
    const match = readFileSync(path, 'utf8').match(/"main"\s*:\s*"([^"]+)"/)
    if (match?.[1]) {
      worker = match[1].replace(/^\.\//, '')
      break
    }
  }
  const assets = existsSync(join(cwd, 'dist/client')) ? 'dist/client' : undefined
  return assets ? { worker, assets } : { worker }
}
