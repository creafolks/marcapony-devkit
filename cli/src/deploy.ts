import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { collectAssets } from './assets.js'
import {
  CliError,
  EXIT,
  closeSourceGrant,
  createDeployment,
  describeMovedBy,
  fetchDeployment,
  fetchKeyInfo,
  fetchSourceGrant,
  fetchSourceHead,
  validateDeployment,
  type DeploymentRequest,
  type DeploymentSource,
  type DeployNotice,
  type DeploymentView,
  type SourceHead,
} from './api.js'
import {
  isManifestV2,
  publicDirOf,
  readConfig,
  resolveApiRoot,
  serverPathOf,
  type MarcaponyConfig,
} from './config.js'
import { resolveDeployKey } from './credentials.js'
import { localGitHead, readBase, writeBase } from './lock.js'
import { CONFLICT_MARKER } from './merge.js'
import {
  SourcePushRejectedError,
  blockingFindings,
  collectSourceFiles,
  formatFinding,
  pushSource,
  scanForSecrets,
  type PushSourceOptions,
} from './source.js'
import { formatSourceUsage, isOverSourceLimit } from './usage.js'
import { cliFetch, projectSdkVersion } from './client-info.js'
import { noteServerCliNotice } from './update-check.js'

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
  /** Use the one-time direct deploy allowed in the dashboard (release-only production). */
  direct?: boolean
  /** Warn when the app key expires within 14 days (one extra request after the deploy). */
  checkKeyExpiry?: boolean
  /** Injected in tests. */
  now?: () => Date
}

/** What a deploy did, for `--json`. */
export interface DeployResult {
  deployment: DeploymentView
  source: DeploymentSource | null
  base: string | null
  forced: boolean
  /** Newer CLI or SDK versions the platform pointed out; empty when there are none. */
  notices: DeployNotice[]
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
  const fetchImpl = options.fetchImpl ?? cliFetch
  const config = readConfig(options.cwd)
  if (!config) {
    throw new CliError('No marcapony.json found. Run `marcapony app link` first.', {
      exitCode: EXIT.notLinked,
    })
  }

  const apiRoot = resolveApiRoot(options.cliEnv)
  const apiKey = await resolveDeployKey({ cwd: options.cwd, env: options.env, apiRoot, fetchImpl })
  if (!apiKey) {
    throw new CliError(
      'No MARCAPONY_API_KEY found in the environment or .env.local, and no login. Run `marcapony app link` first.',
      { exitCode: EXIT.notLinked },
    )
  }
  const force = options.force === true
  const direct = options.direct === true

  const disabledReason = sourcePushDisabledReason(options)
  const sourceFiles = disabledReason ? null : safeCollect(options.cwd, config, log)
  if (sourceFiles) refuseConflictMarkers(options.cwd, sourceFiles)

  // 1-2. The server's view of the branch, and the check against our base.
  const head = await fetchSourceHead(apiRoot, apiKey, fetchImpl)
  const sync = head?.enabled && head.environmentId ? head : null
  const base = sync ? resolveBase(options.cwd, sync, force) : undefined
  const declarations = declarationsOf(config)
  await withReleaseHint(direct, () =>
    validateDeployment(
      apiRoot,
      apiKey,
      {
        ...(isManifestV2(config) ? { manifest: manifestOf(config) } : declarations),
        withSource: !!sourceFiles && sourceFiles.length > 0,
        ...(base !== undefined ? { baseSourceRef: base } : {}),
        ...(force ? { force: true } : {}),
        ...(direct ? { direct: true } : {}),
      },
      fetchImpl,
    ),
  )

  // The repo was over its limit when last measured: deploys with source are
  // refused until it is back under, so say it before the build.
  if (sourceFiles && isOverSourceLimit(sync?.sourceUsage)) {
    log(
      `Warning: ${formatSourceUsage(sync!.sourceUsage!)}. Deploys that save source are refused until large files are removed; push a version without them, or deploy with --no-source.`,
    )
  }

  // 3. The build. No credential of ours exists in the process yet.
  log(`Building: ${config.build}`)
  ;(options.runBuild ?? defaultRunBuild)(config.build, options.cwd)

  const serverPath = serverPathOf(config)
  const workerPath = join(options.cwd, serverPath)
  if (!existsSync(workerPath)) {
    const field = isManifestV2(config) ? 'server' : 'worker'
    throw new Error(
      `Server module not found at ${serverPath}. Check the "${field}" path in marcapony.json.`,
    )
  }
  const workerBytes = readFileSync(workerPath)
  const worker = workerBytes.toString('base64')

  let assets: ReturnType<typeof collectAssets> | undefined
  const publicDir = publicDirOf(config, options.cwd)
  if (publicDir) {
    const assetsPath = join(options.cwd, publicDir)
    if (!existsSync(assetsPath) || !statSync(assetsPath).isDirectory()) {
      const field = isManifestV2(config) ? 'public.dir' : 'assets'
      throw new Error(
        `Public files not found at ${publicDir}. Check the "${field}" path in marcapony.json.`,
      )
    }
    assets = collectAssets(
      assetsPath,
      isManifestV2(config) ? (config.public?.ignore ?? []) : undefined,
    )
    log(`Uploading the server + ${assets.length} public file(s)`)
  } else {
    log('Uploading the server')
  }

  // 4. Push on top of the base (on top of the head with --force). An empty
  // list would commit an empty tree and wipe the stored source.
  const parent = sync ? (force ? sync.head : (base ?? null)) : undefined
  let source: DeploymentSource | null = null
  if (sourceFiles && sourceFiles.length > 0) {
    source = await trySourcePush({
      options,
      apiRoot,
      apiKey,
      files: sourceFiles,
      parent,
      log,
      bundleHash: bundleHashOf(workerBytes, assets ?? []),
    })
  } else if (sourceFiles) {
    log('Source not saved: no files left after the ignore rules')
  } else if (disabledReason) {
    log(`Source not saved: ${disabledReason}`)
  }

  // The pushed commit is the branch head now, whatever the deploy does next:
  // record it at once, or a failed deploy would leave the lock behind the
  // branch and the next deploy would stop on this project's own commit.
  if (source && sync?.environmentId) writeBase(options.cwd, sync.environmentId, source.commit)

  // 5. Deploy. The server checks the claim again, for every CLI version.
  let deployment: DeploymentView
  try {
    deployment = await createDeployment(
      apiRoot,
      apiKey,
      {
        worker: { main: 'index.js', content: worker, encoding: 'base64' },
        ...(assets ? { assets } : {}),
        ...runtimeFieldsOf(config),
        ...(source ? { source } : {}),
        ...(base !== undefined ? { baseSourceRef: base } : {}),
        ...(force ? { force: true } : {}),
        ...(direct ? { direct: true } : {}),
      },
      fetchImpl,
      options.sleep,
      { sdkVersion: projectSdkVersion(options.cwd) },
    )
  } catch (err) {
    if (err instanceof CliError && err.code === 'release_only') throw releaseOnlyError(err, direct)
    if (err instanceof CliError && err.code === 'source_quota_exceeded') {
      throw new CliError(
        `${err.message}. The app's Code tab in the dashboard shows the repo's size.`,
        { code: err.code, status: err.status },
      )
    }
    throw err
  }

  // 6. The new base: the pushed commit, or the head we deployed on top of.
  if (sync?.environmentId) {
    const newBase = source?.commit ?? (force ? sync.head : (base ?? null))
    writeBase(options.cwd, sync.environmentId, newBase)
  }

  // A poll answers with the deployment alone; what the deploy said comes from its own answer.
  const warnings = deployment.warnings ?? []
  const notices = deployment.notices ?? []
  if (notices.some((notice) => notice.kind === 'cli_update')) noteServerCliNotice()

  const sleep = options.sleep ?? defaultSleep
  for (let i = 0; deployment.status === 'uploading' && i < POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS)
    deployment = await fetchDeployment(apiRoot, apiKey, deployment.id, fetchImpl)
  }

  for (const warning of warnings) log(`Warning: ${warning}`)

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
  if (options.checkKeyExpiry) {
    await warnIfKeyExpiring(apiRoot, apiKey, fetchImpl, log, options.now?.() ?? new Date())
  }
  return {
    deployment: { ...deployment, warnings, notices },
    source,
    base: base ?? null,
    forced: force,
    notices,
  }
}

/**
 * A production that goes live through releases refuses a plain deploy with
 * 409 `release_only`. The platform's message says what to do in the
 * dashboard; this adds the terminal side.
 */
function releaseOnlyError(err: CliError, direct: boolean): CliError {
  const hint = direct
    ? 'Allow a one-time direct deploy on the app page in the dashboard (it stays valid for 30 minutes), then run `marcapony app deploy --direct` again.'
    : 'Deploy to the test environment and take it live with `marcapony app release` (needs `marcapony login`). To ship a hotfix straight to production instead, allow a one-time direct deploy on the app page and run `marcapony app deploy --direct`.'
  return new CliError(`${err.message} ${hint}`, {
    code: err.code,
    status: err.status,
    exitCode: EXIT.refused,
  })
}

async function withReleaseHint<T>(direct: boolean, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof CliError && err.code === 'release_only') throw releaseOnlyError(err, direct)
    throw err
  }
}

/**
 * The bundle's sha256 the way the platform computes it for the deployment:
 * the server module's bytes, then each public file's bytes in upload order,
 * as one stream. Paths are not part of it.
 */
export function bundleHashOf(
  workerBytes: Uint8Array,
  assets: ReadonlyArray<{ content: string }>,
): string {
  const hash = createHash('sha256')
  hash.update(workerBytes)
  for (const asset of assets) hash.update(Buffer.from(asset.content, 'base64'))
  return hash.digest('hex')
}

export const KEY_EXPIRY_WARNING_DAYS = 14

/** Best effort: a key that expires soon is renewed by linking again. Never fails the deploy. */
export async function warnIfKeyExpiring(
  apiRoot: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  log: (message: string) => void,
  now: Date,
): Promise<void> {
  let info: Awaited<ReturnType<typeof fetchKeyInfo>>
  try {
    info = await fetchKeyInfo(apiRoot, apiKey, fetchImpl)
  } catch {
    return
  }
  // A login's session key lives an hour by design; it is renewed every command.
  if (!info?.expiresAt || info.cliLabel === 'session') return
  const days = Math.ceil((new Date(info.expiresAt).getTime() - now.getTime()) / 86_400_000)
  if (!Number.isFinite(days) || days > KEY_EXPIRY_WARNING_DAYS) return
  const command = info.cliLabel === 'ci' ? 'marcapony app link --ci' : 'marcapony app link'
  log(
    `Warning: this app key expires in ${Math.max(days, 0)} day(s), on ${info.expiresAt.slice(0, 10)}. Get a pairing code from the app page and run \`${command}\` to renew it.`,
  )
}

/**
 * What the deploy says about the runtime: a version 2 manifest goes as
 * written and the platform translates it; version 1 fields go as before.
 */
function runtimeFieldsOf(config: MarcaponyConfig): Partial<DeploymentRequest> {
  if (isManifestV2(config)) return { manifest: manifestOf(config) }
  return {
    ...(config.compatibilityDate ? { compatibilityDate: config.compatibilityDate } : {}),
    ...(config.compatibilityFlags ? { compatibilityFlags: config.compatibilityFlags } : {}),
    ...(config.assetsConfig ? { assetsConfig: config.assetsConfig } : {}),
    ...declarationsOf(config),
  }
}

function manifestOf(config: MarcaponyConfig): Record<string, unknown> {
  const { $schema: _schema, ...manifest } = config
  return manifest
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
    // A clone of the environment's branch (`git clone`, then `app link`):
    // its own HEAD is the base.
    if (localGitHead(cwd) === head.head) return head.head
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

/**
 * "A forced git push landed", "Ayşe force-pushed": only a phrase without a
 * verb needs one, after a comma when the phrase ends in ", version 7".
 */
function landed(movedBy: NonNullable<SourceHead['movedBy']>): string {
  if (movedBy.kind === 'proposal') return movedBy.version === null ? ' landed' : ', landed'
  return movedBy.kind === 'push' && !movedBy.name ? ' landed' : ''
}

export function remoteChangesMessage(head: SourceHead): string {
  const who = head.movedBy
    ? `${describeMovedBy(head.movedBy)}${landed(head.movedBy)}`
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
  bundleHash: string
}): Promise<DeploymentSource | null> {
  const { options, apiRoot, apiKey, files, parent, log, bundleHash } = args
  const fetchImpl = options.fetchImpl ?? cliFetch
  try {
    const findings = scanForSecrets(options.cwd, files)
    const blocking = blockingFindings(findings)
    if (blocking.length > 0) {
      log('Secret scan found possible secrets:')
      for (const f of blocking) log(`  ${formatFinding(f)}`)
      log(
        blocking.some((f) => f.kind === 'provider')
          ? 'Warning: source not saved. Move the keys to `marcapony app env set` and rotate them. The deploy continues.'
          : 'Warning: source not saved. Move the values to `marcapony app env set`, or mark a high-entropy test string with a "marcapony-scan: allow" comment. The deploy continues.',
      )
      return null
    }
    const allowed = findings.filter((f) => f.allowed)
    if (allowed.length > 0) {
      log(`Secret scan: ${allowed.length} match(es) allowed by comment or test-fixture rule:`)
      for (const f of allowed) log(`  ${formatFinding(f)}`)
      if (allowed.some((f) => f.kind === 'provider')) {
        log(
          'Warning: the platform does not accept the allow comment for provider keys (Stripe, AWS, GitHub and the like). The source is saved, but that version will be blocked from reading, and removing the key in a later version does not unblock it: rotate the key.',
        )
      }
    }
    const grant = await fetchSourceGrant(apiRoot, apiKey, fetchImpl, options.sleep, {
      direct: options.direct === true,
    })
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
        // An older platform knows no base: its grant's head, else the remote head.
        parent: parent === undefined ? (grant.headBefore ?? undefined) : parent,
        message: options.message,
        bundleHash,
      })
    } finally {
      // Revokes the token at once instead of leaving it to expire.
      if (grant.grantId) {
        await closeSourceGrant(apiRoot, apiKey, grant.grantId, fetchImpl).catch(() => undefined)
      }
    }
    log(`Source saved: commit ${shortCommit(commit)} (${files.length} file(s))`)
    // As last measured, before this push; the platform measures again after its scan.
    if (grant.sourceUsage) log(formatSourceUsage(grant.sourceUsage))
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
