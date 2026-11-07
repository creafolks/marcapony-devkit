import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `marcapony.json` — the project's link to its Marcapony app. Written by
 * `marcapony app link`, read by `marcapony app deploy`. Deliberately small:
 * which app, how to build, and what to upload.
 */
export interface MarcaponyConfig {
  /** Editor completion for the fields; ignored by the CLI. */
  $schema?: string
  /** The format version: 2, or absent for the first format. */
  manifest?: 2
  /** App slug, as issued by the platform. */
  app: string
  /** Build command run before bundling (e.g. `bun run build`). */
  build: string
  /** The built server module, exporting `{ fetch(request, env, ctx) }`. Version 2. */
  server?: string
  /** The built public files, and files in it that are never uploaded. Version 2. */
  public?: { dir?: string; ignore?: string[] }
  /** Paths that always reach the server, and what a missing page serves. Version 2. */
  routes?: { server?: string[]; notFound?: 'spa' | 'page' | 'none' }
  /** The Marcapony runtime version, `YYYY-MM`. Version 2. */
  runtime?: string
  /** Files never saved with the source, in gitignore syntax (`!` re-includes). Version 2. */
  ignore?: string[]
  /** The settings and secrets the app needs, set per environment. Version 2. */
  env?: Record<string, { secret?: boolean; required?: boolean; description?: string }>
  /** Version 1: the built server module. */
  worker?: string
  /** Version 1: the built public files. */
  assets?: string
  /** Version 1: static file behaviour, replaced by `routes` in version 2. */
  assetsConfig?: Record<string, unknown>
  /** Version 1: replaced by `runtime` in version 2. */
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
/** Where `link` writes the key for a version 2 project. */
export const ENV_FILE = '.env.local'
/** Where version 1 projects keep it; still read as a fallback. */
export const LEGACY_ENV_FILE = '.dev.vars'
export const GITIGNORE_FILE = '.gitignore'

/** Where the build puts the server and the public files, unless the manifest says otherwise. */
export const MANIFEST_DEFAULTS = {
  server: 'dist/server/index.js',
  publicDir: 'dist/client',
} as const

/** The newest Marcapony runtime version; new projects pin it. */
export const NEWEST_RUNTIME = '2026-10'
export const SCHEMA_REF = './node_modules/marcapony/manifest.schema.json'

export function isManifestV2(config: Pick<MarcaponyConfig, 'manifest'>): boolean {
  return config.manifest === 2
}

/** The built server module, for either format. */
export function serverPathOf(config: MarcaponyConfig): string {
  if (isManifestV2(config)) return config.server ?? MANIFEST_DEFAULTS.server
  return config.worker ?? MANIFEST_DEFAULTS.server
}

/** The built public files directory, if the app has one. */
export function publicDirOf(config: MarcaponyConfig, cwd?: string): string | undefined {
  if (!isManifestV2(config)) return config.assets
  if (config.public?.dir) return config.public.dir
  return cwd && existsSync(join(cwd, MANIFEST_DEFAULTS.publicDir))
    ? MANIFEST_DEFAULTS.publicDir
    : undefined
}

/** The local file the key lives in: the v2 name, or the v1 one where that is what the project has. */
export function envFileOf(cwd: string, config: Pick<MarcaponyConfig, 'manifest'> | null): string {
  if (config && !isManifestV2(config)) return LEGACY_ENV_FILE
  if (!existsSync(join(cwd, ENV_FILE)) && existsSync(join(cwd, LEGACY_ENV_FILE))) {
    return LEGACY_ENV_FILE
  }
  return ENV_FILE
}

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

export function isCliEnv(name: string): name is CliEnv {
  return Object.hasOwn(API_ROOTS, name)
}

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

export function readEnvFile(cwd: string, file: string = ENV_FILE): string {
  const path = join(cwd, file)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

export function writeEnvFile(cwd: string, content: string, file: string = ENV_FILE): void {
  writeFileSync(join(cwd, file), content)
}

/**
 * `.dev.vars` holds a live key with the app's data scopes plus apps:deploy, and
 * `marcapony app link` can run in any project — including one whose .gitignore
 * never heard of the file. Committing it publishes the tenant's credential, so
 * ignore it before the key is written rather than trusting a scaffold to have
 * done it. Returns true when this call added the entry.
 */
export function ensureEnvFileIgnored(cwd: string, file: string = ENV_FILE): boolean {
  const path = join(cwd, GITIGNORE_FILE)
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const alreadyIgnored = current
    .split('\n')
    .map((line) => line.trim())
    .some(
      (line) =>
        line === file || line === `/${file}` || (file.startsWith('.env') && line === '.env*'),
    )
  if (alreadyIgnored) return false

  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n'
  writeFileSync(path, `${current}${separator}${file}\n`)
  return true
}

/**
 * The deploy credential: an exported env var wins (CI), otherwise the key
 * `marcapony app link` wrote into `.env.local` (or `.dev.vars` in a project
 * linked before version 2).
 */
export function resolveApiKey(cwd: string, env: NodeJS.ProcessEnv): string | null {
  if (env.MARCAPONY_API_KEY) return env.MARCAPONY_API_KEY
  return (
    parseEnvLines(readEnvFile(cwd, ENV_FILE)).MARCAPONY_API_KEY ??
    parseEnvLines(readEnvFile(cwd, LEGACY_ENV_FILE)).MARCAPONY_API_KEY ??
    null
  )
}

/**
 * Best-effort defaults for a fresh link: the server entry from a wrangler
 * config when one exists (it is dev plumbing here, never a deploy path), and
 * the public files directory when the build already made it.
 */
export function detectDefaults(cwd: string): { server: string; publicDir?: string } {
  let server: string = MANIFEST_DEFAULTS.server
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    const path = join(cwd, name)
    if (!existsSync(path)) continue
    // Line-scan rather than parse: wrangler.jsonc allows comments and trailing
    // commas, and a config read must never be the thing that fails a link.
    const match = readFileSync(path, 'utf8').match(/"main"\s*:\s*"([^"]+)"/)
    if (match?.[1]) {
      server = match[1].replace(/^\.\//, '')
      break
    }
  }
  const publicDir = existsSync(join(cwd, MANIFEST_DEFAULTS.publicDir))
    ? MANIFEST_DEFAULTS.publicDir
    : undefined
  return publicDir ? { server, publicDir } : { server }
}
