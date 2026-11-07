import { CliError, EXIT } from './api.js'
import { resolveApiRoot } from './config.js'
import { loginRequired, pickLogin, type CredentialDeps } from './credentials.js'
import {
  createRelease,
  fetchLinkableApps,
  getRelease,
  listReleases,
  previewRelease,
  retryRelease,
  type Release,
  type ReleasePreview,
} from './login-api.js'
import { readProjectLink } from './project-link.js'

/**
 * Releases from the terminal: `marcapony app release`, `release list`,
 * `rollback <n>` and `release retry <n>`. Taking a version to production is
 * the business's decision, so these work with your `marcapony login` only,
 * never with an app key, and the platform runs the same checks as the
 * dashboard's "Canlıya al".
 */

export interface ReleaseOptions {
  cwd: string
  cliEnv?: string
  log?: (message: string) => void
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  credentialDeps?: CredentialDeps
}

const PRODUCTION = 'production'
const POLL_MS = 3000
const POLL_LIMIT_MS = 15 * 60 * 1000

/** What each blocker means and the command or place that fixes it. */
const BLOCKER_TEXT: Record<string, string> = {
  deploy_not_live: 'The version is not live in its environment.',
  bundle_not_stored: 'The version has no stored bundle. Deploy it again with this CLI.',
  no_source: 'The version has no saved source. Deploy it again without --no-source.',
  source_pending: 'The secret scan has not finished yet. Try again in a minute.',
  source_blocked: 'The secret scan blocked this version. Fix the findings and deploy again.',
  source_removed: 'A history cleanup removed this version’s commit. Deploy again.',
  source_unverified:
    'The platform did not see this version’s commit land. Deploy it again with this CLI.',
  missing_values: 'Production lacks required values. Set them with `marcapony app env set`.',
  release_in_progress: 'Another release is going live right now.',
  stored_manifest_unreadable: 'The stored bundle cannot be read. Deploy the version again.',
  deploy_rail_unavailable: 'Releases are not available on this platform yet.',
  identity_widening: 'The version widens what the app may access; change that in the dashboard.',
  no_runtime_key: 'Production has no key to take the app’s permissions from.',
}

async function context(options: ReleaseOptions): Promise<{
  apiRoot: string
  credential: string
  appId: string
  appSlug: string
  log: (message: string) => void
  fetchImpl: typeof fetch
}> {
  const apiRoot = resolveApiRoot(options.cliEnv)
  const project = readProjectLink(options.cwd)
  if (!project || project.apiRoot !== apiRoot) {
    throw loginRequired(
      'Releases need your login. Run `marcapony login`, then `marcapony app link --refresh` in this folder.',
    )
  }
  const login = await pickLogin(apiRoot, { project, ...options.credentialDeps })
  return {
    apiRoot,
    credential: login.credential,
    appId: project.appId,
    appSlug: project.appSlug,
    log: options.log ?? console.log,
    fetchImpl: options.fetchImpl ?? fetch,
  }
}

async function waitForRelease(
  options: ReleaseOptions,
  ctx: Awaited<ReturnType<typeof context>>,
  release: Release,
): Promise<Release> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const deadline = Date.now() + POLL_LIMIT_MS
  let current = release
  let lastStatus = ''
  while (current.status !== 'live' && current.status !== 'failed') {
    if (current.status !== lastStatus) {
      ctx.log(`Release ${current.number}: ${current.status}`)
      lastStatus = current.status
    }
    if (Date.now() > deadline) {
      throw new CliError(
        `Release ${current.number} is still ${current.status}. Check it with \`marcapony app release list\`.`,
        { exitCode: EXIT.failed },
      )
    }
    await sleep(POLL_MS)
    current = await getRelease(ctx.apiRoot, ctx.credential, ctx.appId, current.id, ctx.fetchImpl)
  }
  if (current.status === 'failed') {
    throw new CliError(
      `Release ${current.number} failed at the ${current.failureStep ?? 'unknown'} step${current.error ? `: ${current.error}` : ''}. Retry with \`marcapony app release retry ${current.number}\`.`,
      { code: 'release_failed', exitCode: EXIT.refused },
    )
  }
  ctx.log(`Release ${current.number} is live.`)
  return current
}

export interface PromoteOptions extends ReleaseOptions {
  from?: string
  title?: string
  notes?: string
  yes?: boolean
  overwrite?: boolean
  /** Confirms the preview's warnings without a prompt (`--acknowledge-warnings`). */
  acknowledgeWarnings?: boolean
  confirm?: (question: string) => Promise<boolean>
}

/** `marcapony app release`: preview, confirm, promote, and wait until live or failed. */
export async function runRelease(
  options: PromoteOptions,
): Promise<{ release: Release; preview: ReleasePreview }> {
  const ctx = await context(options)
  const apps = await fetchLinkableApps(ctx.apiRoot, ctx.credential, ctx.fetchImpl)
  const app = apps.find((a) => a.id === ctx.appId)
  if (!app)
    throw new CliError('The linked app is gone from this business.', { exitCode: EXIT.notLinked })
  const candidates = app.environments.filter((e) => e.name !== PRODUCTION && e.liveDeploymentId)
  const source = options.from
    ? app.environments.find((e) => e.name === options.from)
    : candidates.length === 1
      ? candidates[0]
      : undefined
  if (!source) {
    throw new CliError(
      options.from
        ? `No environment ${options.from} in ${app.slug}.`
        : `Pass --from <environment> (${candidates.map((e) => e.name).join(', ') || 'none is live'}).`,
      { exitCode: EXIT.failed },
    )
  }
  if (!source.liveDeploymentId) {
    throw new CliError(`${source.name} has no live version to release.`, { exitCode: EXIT.refused })
  }

  const preview = await previewRelease(
    ctx.apiRoot,
    ctx.credential,
    ctx.appId,
    source.liveDeploymentId,
    ctx.fetchImpl,
  )
  ctx.log(`${app.slug}: ${source.name} v${preview.version} to production`)
  if (preview.olderThanPreviousRelease)
    ctx.log('  This version is older than the previous release.')
  else if (preview.commitCount !== null)
    ctx.log(`  ${preview.commitCount} change(s) since the last release`)
  if (preview.blockers.length > 0) {
    for (const blocker of preview.blockers) {
      ctx.log(
        `  Blocked: ${
          blocker === 'missing_values'
            ? `production lacks ${preview.missingValues.join(', ')}. Set them with \`marcapony app env set\`.`
            : (BLOCKER_TEXT[blocker] ?? `This version cannot go live yet (${blocker}).`)
        }`,
      )
    }
    throw new CliError('The release is blocked.', {
      code: 'release_blocked',
      exitCode: EXIT.refused,
    })
  }
  if (!preview.commitAvailable) {
    throw new CliError('Releases are not available on this platform yet.', {
      code: 'release_commit_unavailable',
      exitCode: EXIT.refused,
    })
  }
  if (preview.productionMoved && !options.overwrite) {
    for (const commit of preview.productionCommits.slice(0, 5)) {
      ctx.log(`  On production only: ${commit.sha.slice(0, 7)} ${commit.message}`)
    }
    throw new CliError(
      'Production has changes this release does not include. Pass --overwrite to replace them.',
      { code: 'production_moved', exitCode: EXIT.refused },
    )
  }
  const warnings = preview.warnings ?? []
  for (const warning of warnings) {
    ctx.log(
      warning === 'bundle_hash_mismatch'
        ? '  Warning: this version was uploaded by the CLI, but its bundle differs from the one its commit names.'
        : `  Warning: ${warning}`,
    )
  }

  // --yes answers "take it live", never the warnings: those need their own
  // flag without a prompt, so a script cannot wave them through by accident.
  if (warnings.length > 0 && !options.acknowledgeWarnings) {
    if (options.yes || !options.confirm) {
      throw new CliError(
        'This version has warnings. Release it from a terminal to confirm them, or pass --acknowledge-warnings.',
        { code: 'release_needs_confirmation', exitCode: EXIT.refused },
      )
    }
    if (!(await options.confirm('Take it live anyway?'))) {
      throw new CliError('Release cancelled.', { exitCode: EXIT.failed })
    }
  } else if (!options.yes) {
    if (!options.confirm) {
      throw new CliError('Run with --yes to release without a prompt.', { exitCode: EXIT.failed })
    }
    if (!(await options.confirm('Take it live?'))) {
      throw new CliError('Release cancelled.', { exitCode: EXIT.failed })
    }
  }

  const created = await createRelease(
    ctx.apiRoot,
    ctx.credential,
    ctx.appId,
    {
      kind: 'promote',
      deploymentId: source.liveDeploymentId,
      title: options.title ?? `${source.name} v${preview.version}`,
      ...(options.notes ? { notes: options.notes } : {}),
      ...(preview.productionMoved ? { overwrite: true } : {}),
      ...(warnings.length > 0 ? { acknowledgeWarnings: true } : {}),
    },
    ctx.fetchImpl,
  )
  return { release: await waitForRelease(options, ctx, created), preview }
}

/** `marcapony app release list` */
export async function runReleaseList(options: ReleaseOptions): Promise<{ releases: Release[] }> {
  const ctx = await context(options)
  const releases = await listReleases(ctx.apiRoot, ctx.credential, ctx.appId, ctx.fetchImpl)
  if (releases.length === 0) ctx.log('No releases yet.')
  for (const r of releases) {
    const kind = r.kind === 'promote' ? '' : ` (${r.kind})`
    ctx.log(
      `${String(r.number).padStart(4)}  ${r.status.padEnd(10)} ${(r.liveAt ?? r.createdAt).slice(0, 10)}  ${r.title}${kind}`,
    )
  }
  return { releases }
}

async function findByNumber(
  ctx: Awaited<ReturnType<typeof context>>,
  number: string | undefined,
): Promise<Release> {
  const n = Number.parseInt(number ?? '', 10)
  if (!Number.isInteger(n) || n < 1) {
    throw new CliError('Pass the release number, as `marcapony app release list` shows it.', {
      exitCode: EXIT.failed,
    })
  }
  const release = (await listReleases(ctx.apiRoot, ctx.credential, ctx.appId, ctx.fetchImpl)).find(
    (r) => r.number === n,
  )
  if (!release) throw new CliError(`No release ${n}.`, { exitCode: EXIT.failed })
  return release
}

/** `marcapony app rollback <number>` */
export async function runRollback(
  options: ReleaseOptions & {
    number?: string
    yes?: boolean
    confirm?: (question: string) => Promise<boolean>
  },
): Promise<{ release: Release }> {
  const ctx = await context(options)
  const target = await findByNumber(ctx, options.number)
  if (!options.yes) {
    if (!options.confirm) {
      throw new CliError('Run with --yes to roll back without a prompt.', { exitCode: EXIT.failed })
    }
    if (!(await options.confirm(`Roll production back to release ${target.number}?`))) {
      throw new CliError('Rollback cancelled.', { exitCode: EXIT.failed })
    }
  }
  const created = await createRelease(
    ctx.apiRoot,
    ctx.credential,
    ctx.appId,
    { kind: 'rollback', releaseId: target.id },
    ctx.fetchImpl,
  )
  return { release: await waitForRelease(options, ctx, created) }
}

/** `marcapony app release retry <number>` */
export async function runReleaseRetry(
  options: ReleaseOptions & { number?: string },
): Promise<{ release: Release }> {
  const ctx = await context(options)
  const target = await findByNumber(ctx, options.number)
  const retried = await retryRelease(
    ctx.apiRoot,
    ctx.credential,
    ctx.appId,
    target.id,
    ctx.fetchImpl,
  )
  return { release: await waitForRelease(options, ctx, retried) }
}
