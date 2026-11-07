import { execSync } from 'node:child_process'
import { CliError, EXIT, fetchSourceHead, fetchSourceReadGrant, type SourceHead } from './api.js'
import { readConfig, resolveApiKey, resolveApiRoot } from './config.js'
import { readBase, writeBase } from './lock.js'
import { unifiedDiff } from './merge.js'
import { readRemoteFiles } from './source.js'
import {
  type FileConflicts,
  isBinary,
  type PullFileAction,
  planConflicts,
  planFiles,
  planThreeWay,
  sameBytes,
  writePlan,
} from './three-way.js'

export interface PullOptions {
  cwd: string
  cliEnv?: string
  env: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  log?: (message: string) => void
  /** Write into files with uncommitted changes without asking. */
  yes?: boolean
  /** Print the remote changes as a patch instead of applying them. */
  patch?: boolean
  /** Run the project's build after a merge. */
  check?: boolean
  /** Whether a person can answer a question; without one the CLI never waits. */
  interactive?: boolean
  confirm?: (question: string) => Promise<boolean>
  /** Injected in tests. */
  readRemote?: typeof readRemoteFiles
  sleep?: (ms: number) => Promise<void>
  runBuild?: (command: string, cwd: string) => void
  /** Force the vendored merge (tests) or git's (undefined: git when present). */
  useGit?: boolean
}

export type { PullFileAction }

const decoder = new TextDecoder()

export interface PullResult {
  status: 'up_to_date' | 'nothing_to_pull' | 'merged' | 'conflicts' | 'patch'
  head: string | null
  base: string | null
  files: Array<{ path: string; action: PullFileAction; conflicts?: number }>
  patch?: string
  /** With conflicts: each conflicted file's regions, base and both sides in full. */
  conflicts?: { headCommit: string; files: FileConflicts[] }
}

const PENDING_WAIT_MS = 60_000
const PENDING_POLL_MS = 3_000

function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : 'none'
}

/**
 * `marcapony app pull`: merge the environment's remote changes into the
 * working tree. base = the base in `marcapony.lock`, theirs = the branch head,
 * ours = the files on disk. A blocked head is never merged and a pending one
 * is waited for. Conflicts get git's diff3 markers and exit
 * code 3; the base moves to the head either way, so the next deploy builds on
 * it once the markers are resolved.
 */
export async function runPull(options: PullOptions): Promise<PullResult> {
  const log = options.log ?? console.log
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const config = readConfig(options.cwd)
  const apiKey = resolveApiKey(options.cwd, options.env)
  if (!config || !apiKey) {
    throw new CliError('This project is not linked. Run `marcapony app link` first.', {
      exitCode: EXIT.notLinked,
    })
  }
  const apiRoot = resolveApiRoot(options.cliEnv)

  let head = await fetchSourceHead(apiRoot, apiKey, fetchImpl)
  if (!head?.enabled || !head.environmentId) {
    log('Nothing to pull: this environment does not store source.')
    return { status: 'nothing_to_pull', head: null, base: null, files: [] }
  }
  for (
    let waited = 0;
    head.scan === 'pending' && waited < PENDING_WAIT_MS;
    waited += PENDING_POLL_MS
  ) {
    log('Waiting for the platform to finish checking the latest commit...')
    await sleep(PENDING_POLL_MS)
    head = (await fetchSourceHead(apiRoot, apiKey, fetchImpl)) ?? head
  }
  refuseUnsafeHead(head)

  const environmentId = head.environmentId!
  const entry = readBase(options.cwd, environmentId)
  const base = entry?.base ? (head.rewrites[entry.base] ?? entry.base) : null
  if (head.head === null) {
    if (!options.patch) writeBase(options.cwd, environmentId, null)
    log('Nothing to pull: the environment has no saved source yet.')
    return { status: 'nothing_to_pull', head: null, base, files: [] }
  }
  if (entry && base === head.head) {
    if (entry.base !== base) writeBase(options.cwd, environmentId, base)
    log('Already up to date.')
    return { status: 'up_to_date', head: head.head, base, files: [] }
  }

  const grant = await fetchSourceReadGrant(apiRoot, apiKey, fetchImpl)
  if (!grant) {
    throw new CliError('The platform has no source for this environment yet.', {
      exitCode: EXIT.refused,
    })
  }
  const readRemote = options.readRemote ?? readRemoteFiles
  const [baseFiles, theirFiles] = await readRemote({ grant, commits: [base, head.head] })
  if (!theirFiles) throw new Error(`Could not read commit ${short(head.head)} from the platform`)
  // A base the branch no longer has (or none at all) merges against nothing,
  // so every file that differs is shown as a conflict to confirm.
  const baseMap = baseFiles ?? new Map<string, Uint8Array>()

  const paths = [...new Set([...baseMap.keys(), ...theirFiles.keys()])].sort()

  if (options.patch) {
    const patch = paths
      .map((p) => {
        const b = baseMap.get(p)
        const t = theirFiles.get(p)
        if (sameBytes(b, t) || isBinary(b) || isBinary(t)) return ''
        return unifiedDiff(p, b ? decoder.decode(b) : null, t ? decoder.decode(t) : null)
      })
      .join('')
    return { status: 'patch', head: head.head, base, files: [], patch }
  }

  const labels = {
    ours: 'yours',
    base: `base ${short(base)}`,
    theirs: `marcapony ${short(head.head)}`,
  }
  const plan = planThreeWay({
    cwd: options.cwd,
    base: baseMap,
    theirs: theirFiles,
    labels,
    useGit: options.useGit,
  })
  await writePlan({ ...options, command: 'marcapony app pull' }, plan)
  writeBase(options.cwd, environmentId, head.head)

  const files = planFiles(plan)
  const conflicted = files.filter((f) => f.action === 'conflict')
  const by = head.movedBy
    ? ` (${head.movedBy.name ?? 'someone'}, version ${head.movedBy.version})`
    : ''
  if (files.every((f) => f.action === 'unchanged')) {
    log(`Your files already contain these changes${by}. Base moved to ${short(head.head)}.`)
  } else {
    log(`Pulled ${short(head.head)}${by}:`)
    for (const f of files)
      log(`  ${f.action.padEnd(9)} ${f.path}${f.conflicts ? ` (${f.conflicts} conflict(s))` : ''}`)
  }
  if (conflicted.length > 0) {
    log(`Resolve the conflicts in ${conflicted.length} file(s), then deploy.`)
    return {
      status: 'conflicts',
      head: head.head,
      base,
      files,
      conflicts: { headCommit: head.head, files: planConflicts(plan) },
    }
  }
  if (options.check) {
    log(`Checking the build: ${config.build}`)
    ;(options.runBuild ?? ((cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' })))(
      config.build,
      options.cwd,
    )
  } else if (files.some((f) => f.action !== 'unchanged')) {
    log(
      `A clean merge is not proof that the code works. Run \`${config.build}\` before you deploy.`,
    )
  }
  return { status: 'merged', head: head.head, base, files }
}

function refuseUnsafeHead(head: SourceHead): void {
  if (head.scan === 'blocked') {
    throw new CliError(
      "The latest commit on this environment is blocked by the platform's checks and will not be merged. Ask an admin to look at the app's code tab.",
      { exitCode: EXIT.refused },
    )
  }
  if (head.scan === 'pending') {
    throw new CliError('The platform is still checking the latest commit. Try again in a minute.', {
      exitCode: EXIT.refused,
    })
  }
}
