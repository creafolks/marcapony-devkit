import {
  CliError,
  EXIT,
  fetchHandedOverChange,
  fetchHandedOverChanges,
  type HandedOverChange,
} from './api.js'
import { readConfig, resolveApiRoot } from './config.js'
import { resolveDeployKey } from './credentials.js'
import {
  type FileConflicts,
  type PullFileAction,
  planConflicts,
  planFiles,
  planThreeWay,
  writePlan,
} from './three-way.js'
import { cliFetch } from './client-info.js'

/**
 * `marcapony app proposals`: changes the app's owner approved in the panel
 * and handed over to the developers instead of committing them. `pull <id>`
 * merges one into the working tree like `marcapony app pull`, without moving
 * the base in `marcapony.lock`: the change reaches the environment with the
 * next deploy, which also closes it.
 */

export interface ProposalsOptions {
  cwd: string
  cliEnv?: string
  env: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  log?: (message: string) => void
}

export interface ProposalPullOptions extends ProposalsOptions {
  id: string | undefined
  /** Write into files with uncommitted changes without asking. */
  yes?: boolean
  interactive?: boolean
  confirm?: (question: string) => Promise<boolean>
  /** Force the vendored merge (tests) or git's (undefined: git when present). */
  useGit?: boolean
}

export interface ProposalPullResult {
  status: 'merged' | 'conflicts'
  id: string
  baseCommit: string
  files: Array<{ path: string; action: PullFileAction; conflicts?: number }>
  /** With conflicts: each conflicted file's regions, base and both sides in full. */
  conflicts?: { proposalId: string; files: FileConflicts[] }
}

async function linked(options: ProposalsOptions): Promise<{ apiRoot: string; apiKey: string }> {
  const apiRoot = resolveApiRoot(options.cliEnv)
  const apiKey = readConfig(options.cwd)
    ? await resolveDeployKey({
        cwd: options.cwd,
        env: options.env,
        apiRoot,
        fetchImpl: options.fetchImpl,
      })
    : null
  if (!apiKey) {
    throw new CliError('This project is not linked. Run `marcapony app link` first.', {
      exitCode: EXIT.notLinked,
    })
  }
  return { apiRoot, apiKey }
}

function short(id: string): string {
  return id.slice(0, 8)
}

export async function runProposalsList(
  options: ProposalsOptions,
): Promise<{ proposals: HandedOverChange[] }> {
  const log = options.log ?? console.log
  const { apiRoot, apiKey } = await linked(options)
  const proposals = await fetchHandedOverChanges(apiRoot, apiKey, options.fetchImpl ?? cliFetch)
  if (proposals.length === 0) {
    log('No changes are waiting for this environment.')
    return { proposals }
  }
  log('Approved changes handed over to you:')
  for (const p of proposals) {
    const by = p.approvedBy ? `, approved by ${p.approvedBy}` : ''
    const files = p.fileCount !== undefined ? `, ${p.fileCount} file(s)` : ''
    log(`  ${p.id}  ${p.summary ?? '(no summary)'}${files}${by}`)
  }
  log('Apply one with `marcapony app proposals pull <id>`, then deploy.')
  return { proposals }
}

export async function runProposalPull(options: ProposalPullOptions): Promise<ProposalPullResult> {
  const log = options.log ?? console.log
  if (!options.id) {
    throw new CliError('Usage: marcapony app proposals pull <id>', { exitCode: EXIT.failed })
  }
  const { apiRoot, apiKey } = await linked(options)
  const change = await fetchHandedOverChange(
    apiRoot,
    apiKey,
    options.id,
    options.fetchImpl ?? cliFetch,
  )

  const encoder = new TextEncoder()
  const base = new Map<string, Uint8Array>()
  const theirs = new Map<string, Uint8Array>()
  for (const file of change.files) {
    if (file.baseContent !== null) base.set(file.path, encoder.encode(file.baseContent))
    if (file.op !== 'delete' && file.content !== null) {
      theirs.set(file.path, encoder.encode(file.content))
    }
  }
  const plan = planThreeWay({
    cwd: options.cwd,
    base,
    theirs,
    labels: {
      ours: 'yours',
      base: `base ${change.baseCommit.slice(0, 7)}`,
      theirs: `change ${short(change.id)}`,
    },
    useGit: options.useGit,
  })
  await writePlan({ ...options, command: `marcapony app proposals pull ${change.id}` }, plan)

  const files = planFiles(plan)
  const title = change.summary ? `: ${change.summary}` : ''
  if (files.every((f) => f.action === 'unchanged')) {
    log(`Your files already contain change ${short(change.id)}${title}.`)
  } else {
    log(`Applied change ${short(change.id)}${title}`)
    for (const f of files)
      log(`  ${f.action.padEnd(9)} ${f.path}${f.conflicts ? ` (${f.conflicts} conflict(s))` : ''}`)
  }
  const conflicted = files.filter((f) => f.action === 'conflict')
  const result = { id: change.id, baseCommit: change.baseCommit, files }
  if (conflicted.length > 0) {
    log(`Resolve the conflicts in ${conflicted.length} file(s), then deploy.`)
    return {
      status: 'conflicts',
      ...result,
      conflicts: { proposalId: change.id, files: planConflicts(plan) },
    }
  }
  log('Check that it builds, commit it, and deploy: the deploy closes the change.')
  return { status: 'merged', ...result }
}
