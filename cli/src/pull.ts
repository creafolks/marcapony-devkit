import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CliError, EXIT, fetchSourceHead, fetchSourceReadGrant, type SourceHead } from './api.js'
import { readConfig, resolveApiKey, resolveApiRoot } from './config.js'
import { readBase, writeBase } from './lock.js'
import { hasGitBinary, mergeFile, unifiedDiff } from './merge.js'
import { readRemoteFiles } from './source.js'

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

export type PullFileAction = 'added' | 'updated' | 'deleted' | 'merged' | 'conflict' | 'unchanged'

export interface PullResult {
  status: 'up_to_date' | 'nothing_to_pull' | 'merged' | 'conflicts' | 'patch'
  head: string | null
  base: string | null
  files: Array<{ path: string; action: PullFileAction; conflicts?: number }>
  patch?: string
}

const PENDING_WAIT_MS = 60_000
const PENDING_POLL_MS = 3_000

function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : 'none'
}

function same(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function isBinary(bytes: Uint8Array | undefined): boolean {
  return bytes?.includes(0) === true
}

const decoder = new TextDecoder()

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
        if (same(b, t) || isBinary(b) || isBinary(t)) return ''
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
  const plan: Array<{
    path: string
    action: PullFileAction
    content?: Uint8Array | string | null
    conflicts?: number
  }> = []
  for (const path of paths) {
    const b = baseMap.get(path)
    const t = theirFiles.get(path)
    if (same(b, t)) continue
    const o = readWorkingFile(options.cwd, path)
    if (same(o, t)) {
      plan.push({ path, action: 'unchanged' })
    } else if (same(o, b)) {
      plan.push({
        path,
        action: t === undefined ? 'deleted' : o === undefined ? 'added' : 'updated',
        content: t ?? null,
      })
    } else if (o === undefined || t === undefined || isBinary(o) || isBinary(t) || isBinary(b)) {
      // Deleted on one side and changed on the other, or binary: nothing to
      // merge line by line, so the file is left as it is and listed.
      plan.push({ path, action: 'conflict', conflicts: 1 })
    } else {
      const merged = mergeFile(
        decoder.decode(o),
        b ? decoder.decode(b) : '',
        decoder.decode(t),
        labels,
        options.useGit,
      )
      plan.push({
        path,
        action: merged.conflicts > 0 ? 'conflict' : 'merged',
        content: merged.text,
        ...(merged.conflicts > 0 ? { conflicts: merged.conflicts } : {}),
      })
    }
  }

  const writes = plan.filter((p) => p.content !== undefined)
  await guardUncommittedChanges(
    options,
    writes.map((w) => w.path),
  )
  for (const w of writes) {
    const target = join(options.cwd, w.path)
    if (w.content === null) {
      rmSync(target, { force: true })
    } else {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, w.content as string | Uint8Array)
    }
  }
  writeBase(options.cwd, environmentId, head.head)

  const files = plan.map(({ path, action, conflicts }) => ({
    path,
    action,
    ...(conflicts ? { conflicts } : {}),
  }))
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
    return { status: 'conflicts', head: head.head, base, files }
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

function readWorkingFile(cwd: string, path: string): Uint8Array | undefined {
  const full = join(cwd, path)
  if (!existsSync(full)) return undefined
  try {
    return new Uint8Array(readFileSync(full))
  } catch {
    return undefined
  }
}

/** Files with uncommitted changes in the developer's own git, among `paths`. */
function dirtyPaths(cwd: string, paths: string[]): string[] {
  if (paths.length === 0 || !hasGitBinary()) return []
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', ...paths], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3))
  } catch {
    return [] // not a git repo
  }
}

async function guardUncommittedChanges(options: PullOptions, paths: string[]): Promise<void> {
  if (options.yes) return
  const dirty = dirtyPaths(options.cwd, paths)
  if (dirty.length === 0) return
  const list = dirty.slice(0, 10).join(', ')
  if (options.interactive && options.confirm) {
    if (
      await options.confirm(
        `These files have uncommitted changes: ${list}. Merge into them anyway?`,
      )
    ) {
      return
    }
  }
  throw new CliError(
    `These files have uncommitted changes: ${list}. Commit or stash them, or run \`marcapony app pull --yes\`.`,
    { exitCode: EXIT.refused },
  )
}
