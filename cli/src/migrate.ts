import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CliError, EXIT } from './api.js'
import {
  NEWEST_RUNTIME,
  SCHEMA_REF,
  isManifestV2,
  readConfig,
  writeConfig,
  type MarcaponyConfig,
} from './config.js'
import { parseAssetsIgnore } from './assets.js'

/** Runtime dates the first format used, mapped to the runtime version that keeps them. */
const RUNTIME_BY_DATE: Array<{ fromDate: string; runtime: string }> = [
  { fromDate: '2026-10-01', runtime: '2026-10' },
  { fromDate: '0000-00-00', runtime: '2025-05' },
]

const NOT_FOUND: Record<string, 'spa' | 'page' | 'none'> = {
  'single-page-application': 'spa',
  '404-page': 'page',
  none: 'none',
}

export interface MigrateResult {
  config: MarcaponyConfig
  changes: string[]
  notes: string[]
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

/** A version 1 manifest as version 2, and what changed. Pure apart from reading the ignore files. */
export function migrateConfig(cwd: string, v1: MarcaponyConfig): MigrateResult {
  const changes: string[] = []
  const notes: string[] = []
  const {
    worker,
    assets,
    assetsConfig,
    compatibilityDate,
    compatibilityFlags,
    $schema: _schema,
    manifest: _manifest,
    ...kept
  } = v1
  const v2: MarcaponyConfig = { $schema: SCHEMA_REF, manifest: 2, ...kept }

  if (worker) {
    v2.server = worker
    changes.push(`worker -> server (${worker})`)
  }
  if (assets) {
    const ignore = parseAssetsIgnore(readLines(join(cwd, assets, '.assetsignore')).join('\n'))
    v2.public = { dir: assets, ...(ignore.length > 0 ? { ignore } : {}) }
    changes.push(`assets -> public.dir (${assets})`)
    if (ignore.length > 0)
      changes.push(`${assets}/.assetsignore -> public.ignore (${ignore.length} rule(s))`)
  }
  if (assetsConfig) {
    const routes: NonNullable<MarcaponyConfig['routes']> = {}
    const nf = assetsConfig.not_found_handling
    if (typeof nf === 'string' && NOT_FOUND[nf]) routes.notFound = NOT_FOUND[nf]
    const first = assetsConfig.run_worker_first
    if (Array.isArray(first))
      routes.server = first.filter((p): p is string => typeof p === 'string')
    else if (first === true) routes.server = ['/*']
    v2.routes = routes
    changes.push('assetsConfig -> routes')
    const unknown = Object.keys(assetsConfig).filter(
      (k) => k !== 'not_found_handling' && k !== 'run_worker_first',
    )
    if (unknown.length > 0) notes.push(`Not carried over: assetsConfig ${unknown.join(', ')}`)
  }
  const date = compatibilityDate ?? '0000-00-00'
  const runtime = RUNTIME_BY_DATE.find((r) => date >= r.fromDate)?.runtime ?? NEWEST_RUNTIME
  v2.runtime = runtime
  changes.push(`compatibilityDate/compatibilityFlags -> runtime ${runtime}`)
  if (compatibilityFlags?.some((f) => f !== 'nodejs_compat')) {
    notes.push(
      `Not carried over: compatibility flags ${compatibilityFlags.filter((f) => f !== 'nodejs_compat').join(', ')}`,
    )
  }
  const ignore = readLines(join(cwd, '.marcaponyignore'))
  if (ignore.length > 0) {
    v2.ignore = ignore
    changes.push(`.marcaponyignore -> ignore (${ignore.length} rule(s)); you can delete the file`)
  }
  if (existsSync(join(cwd, '.dev.vars')) && !existsSync(join(cwd, '.env.local'))) {
    notes.push('Your key stays in .dev.vars, which keeps working. New projects use .env.local.')
  }
  return { config: v2, changes, notes }
}

/** `marcapony app migrate-config`: rewrite marcapony.json to version 2 and print what changed. */
export function runMigrateConfig(options: {
  cwd: string
  log?: (m: string) => void
}): MigrateResult {
  const log = options.log ?? console.log
  const config = readConfig(options.cwd)
  if (!config) {
    throw new CliError('No marcapony.json found. Run `marcapony app link` first.', {
      exitCode: EXIT.notLinked,
    })
  }
  if (isManifestV2(config)) {
    log('marcapony.json is already version 2.')
    return { config, changes: [], notes: [] }
  }
  const result = migrateConfig(options.cwd, config)
  writeConfig(options.cwd, result.config)
  log('marcapony.json moved to version 2:')
  for (const c of result.changes) log(`  ${c}`)
  for (const n of result.notes) log(`  Note: ${n}`)
  return result
}
