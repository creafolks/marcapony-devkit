import { execSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { collectAssets } from './assets.js'
import {
  CliError,
  EXIT,
  closeSourceGrant,
  createDeployment,
  fetchDeployment,
  fetchSourceGrant,
  fetchSourceHead,
  validateDeployment,
  type DeploymentRequest,
  type DeploymentSource,
  type DeploymentView,
  type SourceHead,
} from './api.js'
import { readConfig, resolveApiKey, resolveApiRoot, type MarcaponyConfig } from './config.js'
import { readBase, writeBase } from './lock.js'
import { CONFLICT_MARKER } from './merge.js'
import {
  SourcePushRejectedError,
  collectSourceFiles,
  pushSource,
  scanForSecrets,
  type PushSourceOptions,
} from './source.js'

export interface DeployOptions {
  cwd: string
  /** Hidden team override: local | staging | production (defaults to production). */
  cliEnv?: string
  env: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  /** Injected in tests so no real build runs. */
  runBuild?: (command: string, cwd: string) => void
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  /** Version message stored with the source commit. */
  message?: string
  /** Injected in tests so no real git push happens. */
  pushSourceImpl?: (options: PushSourceOptions) => Promise<string>
  /** False when the user passed --no-source. Source push is on by default. */
  source?: boolean
  /** Replace commits on the branch that this project has not pulled. */
  force?: boolean
}

/** What a deploy did, for `--json`. */
export interface DeployResult {
  deployment: DeploymentView
  source: DeploymentSource | null
  base: string | null
  forced: boolean
}

/**
 * Source push is on by default. `--no-source` turns it off for one run and
 * MARCAPONY_SOURCE_PUSH=0 turns it off everywhere. Returns the reason when off.
 */
function sourcePushDisabledReason(options: DeployOptions): string | null {
  if (options.source === false) return 'turned off with --no-source'
  const value = options.env.MARCAPONY_SOURCE_PUSH?.trim().toLowerCase()
  if (value === '0' || value === 'false' || value === 'off') {
    return 'turned off by MARCAPONY_SOURCE_PUSH'
  }
  return null
}

function shortCommit(commit: string): string {
  return commit.slice(0, 7)
}

const POLL_INTERVAL_MS = 2000
const POLL_ATTEMPTS = 60

function defaultRunBuild(command: string, cwd: string): void {
  execSync(command, { cwd, stdio: 'inherit' })
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `marcapony app deploy`, in this order: validate with the
 * server, check the branch head against this project's base, build, push a
 * commit whose parent is the base, deploy, and save the new base in
 * `marcapony.lock`. The environment is derived from the key, so there is no
 * --env flag. wrangler and the project's own git repo are never involved.
 */
export async function runDeploy(options: DeployOptions): Promise<DeploymentView> {
  return (await runDeployDetailed(options)).deployment
}

export async function runDeployDetailed(options: DeployOptions): Promise<DeployResult> {
  const log = options.log ?? console.log
  const fetchImpl = options.fetchImpl ?? fetch
  const config = readConfig(options.cwd)
  if (!config) {
    throw new CliError('No marcapony.json found. Run `marcapony app link` first.', {
      exitCode: EXIT.notLinked,
    })
  }

  const apiKey = resolveApiKey(options.cwd, options.env)
  if (!apiKey) {
    throw new CliError(
      'No MARCAPONY_API_KEY found in the environment or .dev.vars. Run `marcapony app link` first.',
      { exitCode: EXIT.notLinked },
    )
  }
  const apiRoot = resolveApiRoot(options.cliEnv)
  const force = options.force === true

  const disabledReason = sourcePushDisabledReason(options)
  const sourceFiles = disabledReason ? null : safeCollect(options.cwd, config, log)
  if (sourceFiles) refuseConflictMarkers(options.cwd, sourceFiles)

  // 1-2. The server's view of the branch, and the check against our base.
  const head = await fetchSourceHead(apiRoot, apiKey, fetchImpl)
  const sync = head?.enabled && head.environmentId ? head : null
  const base = sync ? resolveBase(options.cwd, sync, force) : undefined
  const declarations = declarationsOf(config)
  await validateDeployment(
    apiRoot,
    apiKey,
    {
      ...declarations,
      withSource: !!sourceFiles && sourceFiles.length > 0,
      ...(base !== undefined ? { baseSourceRef: base } : {}),
      ...(force ? { force: true } : {}),
    },
    fetchImpl,
  )

  // 3. The build. No credential of ours exists in the process yet.
  log(`Building: ${config.build}`)
  ;(options.runBuild ?? defaultRunBuild)(config.build, options.cwd)

  const workerPath = join(options.cwd, config.worker)
  if (!existsSync(workerPath)) {
    throw new Error(
      `Worker module not found at ${config.worker}. Check the "worker" path in marcapony.json.`,
    )
  }
  const worker = readFileSync(workerPath).toString('base64')

  let assets: ReturnType<typeof collectAssets> | undefined
  if (config.assets) {
    const assetsPath = join(options.cwd, config.assets)
    if (!existsSync(assetsPath) || !statSync(assetsPath).isDirectory()) {
      throw new Error(
        `Assets directory not found at ${config.assets}. Check the "assets" path in marcapony.json.`,
      )
    }
    assets = collectAssets(assetsPath)
    log(`Uploading worker + ${assets.length} asset(s)`)
  } else {
    log('Uploading worker')
  }

  // 4. Push on top of the base (on top of the head with --force). An empty
  // list would commit an empty tree and wipe the stored source.
  const parent = sync ? (force ? sync.head : (base ?? null)) : undefined
  let source: DeploymentSource | null = null
  if (sourceFiles && sourceFiles.length > 0) {
    source = await trySourcePush({ options, apiRoot, apiKey, files: sourceFiles, parent, log })
  } else if (sourceFiles) {
    log('Source not saved: no files left after the ignore rules')
  } else if (disabledReason) {
    log(`Source not saved: ${disabledReason}`)
  }

  // 5. Deploy. The server checks the claim again, for every CLI version.
  let deployment = await createDeployment(
    apiRoot,
    apiKey,
    {
      worker: { main: 'index.js', content: worker, encoding: 'base64' },
      ...(config.compatibilityDate ? { compatibilityDate: config.compatibilityDate } : {}),
      ...(config.compatibilityFlags ? { compatibilityFlags: config.compatibilityFlags } : {}),
      ...(assets ? { assets } : {}),
      ...(config.assetsConfig ? { assetsConfig: config.assetsConfig } : {}),
      ...declarations,
      ...(source ? { source } : {}),
      ...(base !== undefined ? { baseSourceRef: base } : {}),
      ...(force ? { force: true } : {}),
    },
    fetchImpl,
  )

  // 6. The new base: the pushed commit, or the head we deployed on top of.
  if (sync?.environmentId) {
    const newBase = source?.commit ?? (force ? sync.head : (base ?? null))
    writeBase(options.cwd, sync.environmentId, newBase)
  }

  const sleep = options.sleep ?? defaultSleep
  for (let i = 0; deployment.status === 'uploading' && i < POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS)
    deployment = await fetchDeployment(apiRoot, apiKey, deployment.id, fetchImpl)
  }

  if (deployment.status === 'failed') {
    throw new Error(`Deploy failed: ${deployment.error ?? 'unknown error'}`)
  }
  if (deployment.status === 'uploading') {
    throw new Error(
      `Deploy did not finish in time. Check status later: deployment ${deployment.id}`,
    )
  }

  // Local dev is served over plain http (wrangler dev has no TLS); a
  // platform-issued hostname is always https. Match localhost / 127.0.0.1 as
  // the actual host (minus any port), not as a substring of a real hostname.
  if (deployment.hostname) {
    const host = deployment.hostname.replace(/:\d+$/, '')
    const local = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1'
    log(`Live: ${local ? 'http' : 'https'}://${deployment.hostname}`)
  } else {
    log(`Live (deployment ${deployment.id})`)
  }
  return { deployment, source, base: base ?? null, forced: force }
}

function declarationsOf(
  config: MarcaponyConfig,
): Pick<DeploymentRequest, 'placement' | 'dataAccess' | 'permissions' | 'portal'> {
  return {
    ...(config.placement ? { placement: config.placement } : {}),
    ...(config.dataAccess ? { dataAccess: config.dataAccess } : {}),
    ...(config.permissions
      ? { permissions: config.permissions.map((p) => ({ ...p, grants: p.grants ?? [] })) }
      : {}),
    ...(config.portal ? { portal: config.portal } : {}),
  }
}

/**
 * The base for this deploy, from `marcapony.lock`. Stops before the build when
 * the branch has commits this project has not seen, unless --force.
 */
function resolveBase(cwd: string, head: SourceHead, force: boolean): string | null {
  const entry = readBase(cwd, head.environmentId!)
  const rewritten = entry?.base ? (head.rewrites[entry.base] ?? entry.base) : (entry?.base ?? null)
  if (head.head === null) return rewritten
  if (entry === undefined) {
    if (force) return null
    throw new CliError(
      'This project has not synced with the environment yet. Run `marcapony app pull` once, then deploy.',
      { code: 'remote_changes', exitCode: EXIT.remoteChanges },
    )
  }
  if (rewritten === head.head || force) return rewritten
  throw new CliError(remoteChangesMessage(head), {
    code: 'remote_changes',
    exitCode: EXIT.remoteChanges,
  })
}

export function remoteChangesMessage(head: SourceHead): string {
  const who = head.movedBy
    ? `${head.movedBy.name ?? 'Someone'} deployed version ${head.movedBy.version}`
    : 'The environment has new commits'
  return `${who} after your last sync. Run \`marcapony app pull\`, or \`marcapony app deploy --force\` to replace them.`
}

/** A file still holding a pull's conflict markers must not be deployed. */
function refuseConflictMarkers(cwd: string, files: string[]): void {
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(join(cwd, file), 'utf8')
    } catch {
      continue
    }
    if (text.includes('\u0000')) continue
    if (CONFLICT_MARKER.test(text) && text.includes('\n=======\n')) {
      throw new CliError(`${file} still has conflict markers. Resolve them, then deploy.`, {
        exitCode: EXIT.conflicts,
      })
    }
  }
}

function safeCollect(
  cwd: string,
  config: NonNullable<ReturnType<typeof readConfig>>,
  log: (message: string) => void,
): string[] | null {
  try {
    return collectSourceFiles(cwd, config)
  } catch (err) {
    log(`Warning: source not saved (${err instanceof Error ? err.message : String(err)})`)
    return null
  }
}

/**
 * Nothing in here may fail the deploy, with one exception: git refusing the
 * push because the branch moved. A secret finding skips the push, an
 * environment without source storage skips it quietly, and any other failure
 * is a warning.
 */
async function trySourcePush(args: {
  options: DeployOptions
  apiRoot: string
  apiKey: string
  files: string[]
  /** Undefined on a platform older than the sync rule: push on the remote head as before. */
  parent: string | null | undefined
  log: (message: string) => void
}): Promise<DeploymentSource | null> {
  const { options, apiRoot, apiKey, files, parent, log } = args
  const fetchImpl = options.fetchImpl ?? fetch
  try {
    const findings = scanForSecrets(options.cwd, files)
    if (findings.length > 0) {
      for (const f of findings) log(`Secret scan: ${f.rule} in ${f.path}:${f.line}`)
      log('Warning: source not saved because the secret scan found possible secrets')
      return null
    }
    const grant = await fetchSourceGrant(apiRoot, apiKey, fetchImpl, options.sleep)
    if (!grant) {
      log('Source not saved: this environment does not store source yet')
      return null
    }
    const push = options.pushSourceImpl ?? pushSource
    let commit: string
    try {
      commit = await push({
        cwd: options.cwd,
        files,
        grant,
        parent: parent === undefined ? (grant.headBefore ?? null) : parent,
        message: options.message,
      })
    } finally {
      // Revokes the token at once instead of leaving it to expire.
      if (grant.grantId) {
        await closeSourceGrant(apiRoot, apiKey, grant.grantId, fetchImpl).catch(() => undefined)
      }
    }
    log(`Source saved: commit ${shortCommit(commit)} (${files.length} file(s))`)
    const message = options.message?.trim()
    return {
      commit,
      ...(message ? { message: message.slice(0, 500) } : {}),
      fileCount: files.length,
      sizeBytes: sourceSize(options.cwd, files),
      ...(grant.grantId ? { grantId: grant.grantId } : {}),
    }
  } catch (err) {
    // Someone pushed during the build: deploying anyway would replace their
    // change, so this one stops the deploy.
    if (err instanceof SourcePushRejectedError && parent !== undefined) {
      throw new CliError(err.message, { code: 'remote_changes', exitCode: EXIT.remoteChanges })
    }
    log(`Warning: source not saved (${err instanceof Error ? err.message : String(err)})`)
    return null
  }
}

function sourceSize(cwd: string, files: string[]): number {
  let total = 0
  for (const file of files) {
    try {
      total += statSync(join(cwd, file)).size
    } catch {
      // A file removed between collection and now just does not count.
    }
  }
  return total
}
