import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CliError, EXIT } from './api.js'
import { hasGitBinary, mergeFile, type MergeLabels } from './merge.js'

/**
 * The three-way merge into the working tree that `marcapony app pull` and
 * `marcapony app proposals pull` share: base and theirs come from the
 * platform, ours is the file on disk.
 */

export type PullFileAction = 'added' | 'updated' | 'deleted' | 'merged' | 'conflict' | 'unchanged'

/**
 * One conflicting region of a file, with each side's lines in full. `ours`
 * is the working tree; null on a side means the file does not exist there.
 */
export interface ConflictRegion {
  id: number
  base: string | null
  ours: string | null
  theirs: string | null
}

export interface FileConflicts {
  path: string
  /** A binary file: no regions, the file is left as it is. */
  binary?: true
  regions: ConflictRegion[]
}

export interface PlannedFile {
  path: string
  action: PullFileAction
  /** What to write; null deletes the file, undefined leaves it alone. */
  content?: Uint8Array | string | null
  conflicts?: number
  regions?: ConflictRegion[]
  binary?: true
}

export interface PlanInput {
  cwd: string
  base: Map<string, Uint8Array>
  theirs: Map<string, Uint8Array>
  labels: MergeLabels
  /** Force the vendored merge (tests) or git's (undefined: git when present). */
  useGit?: boolean
}

const decoder = new TextDecoder()

export function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function isBinary(bytes: Uint8Array | undefined): boolean {
  return bytes?.includes(0) === true
}

function text(bytes: Uint8Array | undefined): string | null {
  return bytes === undefined ? null : decoder.decode(bytes)
}

/** What each file that base and theirs disagree on becomes in the working tree. */
export function planThreeWay(input: PlanInput): PlannedFile[] {
  const paths = [...new Set([...input.base.keys(), ...input.theirs.keys()])].sort()
  const plan: PlannedFile[] = []
  for (const path of paths) {
    const b = input.base.get(path)
    const t = input.theirs.get(path)
    if (sameBytes(b, t)) continue
    const o = readWorkingFile(input.cwd, path)
    if (sameBytes(o, t)) {
      plan.push({ path, action: 'unchanged' })
    } else if (sameBytes(o, b)) {
      plan.push({
        path,
        action: t === undefined ? 'deleted' : o === undefined ? 'added' : 'updated',
        content: t ?? null,
      })
    } else if (isBinary(o) || isBinary(t) || isBinary(b)) {
      // Nothing to merge line by line: the file is left as it is and listed.
      plan.push({ path, action: 'conflict', conflicts: 1, regions: [], binary: true })
    } else if (o === undefined || t === undefined) {
      // Deleted on one side and changed on the other: the file is left as it
      // is, and the one region is the whole file.
      plan.push({
        path,
        action: 'conflict',
        conflicts: 1,
        regions: [{ id: 0, base: text(b), ours: text(o), theirs: text(t) }],
      })
    } else {
      const ours = decoder.decode(o)
      const base = b ? decoder.decode(b) : ''
      const theirs = decoder.decode(t)
      const merged = mergeFile(ours, base, theirs, input.labels, input.useGit)
      plan.push(
        merged.conflicts > 0
          ? {
              path,
              action: 'conflict',
              content: merged.text,
              conflicts: merged.conflicts,
              regions: readConflictRegions(merged.text, input.labels, merged.conflicts, {
                base: b ? base : null,
                ours,
                theirs,
              }),
            }
          : { path, action: 'merged', content: merged.text },
      )
    }
  }
  return plan
}

function joinRegionLines(lines: string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/**
 * The regions of a merged file, read back from its diff3 markers. When the
 * markers cannot be read back exactly, the whole file is one region, which is
 * always correct, only coarser. That is the case when any of the three
 * versions holds a line that reads like a marker (a Markdown heading
 * underline `=======`, for example): such a line would end a section early
 * and still give the expected number of regions.
 */
export function readConflictRegions(
  merged: string,
  labels: MergeLabels,
  expected: number,
  whole: { base: string | null; ours: string; theirs: string },
): ConflictRegion[] {
  const open = `<<<<<<< ${labels.ours}`
  const baseLine = `||||||| ${labels.base}`
  const close = `>>>>>>> ${labels.theirs}`
  const lines = merged.split('\n')
  if (merged.endsWith('\n')) lines.pop()
  const regions: ConflictRegion[] = []
  const wholeFile = (): ConflictRegion[] => [{ id: 0, ...whole }]
  const markers = new Set([open, baseLine, '=======', close])
  const holdsMarker = (side: string | null) =>
    side?.split('\n').some((line) => markers.has(line)) === true
  if (holdsMarker(whole.base) || holdsMarker(whole.ours) || holdsMarker(whole.theirs)) {
    return wholeFile()
  }
  // A region that ends the file keeps each side's own last newline: the
  // merge puts the closing marker on a line of its own either way.
  const ending = (side: string | null, atEnd: boolean, text: string) =>
    atEnd && text.endsWith('\n') && side !== null && side !== '' && !side.endsWith('\n')
      ? text.slice(0, -1)
      : text
  let i = 0
  while (i < lines.length) {
    if (lines[i] !== open) {
      i++
      continue
    }
    const ours: string[] = []
    const base: string[] = []
    const theirs: string[] = []
    let j = i + 1
    while (j < lines.length && lines[j] !== baseLine) ours.push(lines[j++]!)
    j++
    while (j < lines.length && lines[j] !== '=======') base.push(lines[j++]!)
    j++
    while (j < lines.length && lines[j] !== close) theirs.push(lines[j++]!)
    if (j >= lines.length) return wholeFile()
    const atEnd = j === lines.length - 1
    regions.push({
      id: regions.length,
      base: ending(whole.base, atEnd, joinRegionLines(base)),
      ours: ending(whole.ours, atEnd, joinRegionLines(ours)),
      theirs: ending(whole.theirs, atEnd, joinRegionLines(theirs)),
    })
    i = j + 1
  }
  return regions.length === expected ? regions : wholeFile()
}

/** The conflicts of a plan, for `--json`. */
export function planConflicts(plan: PlannedFile[]): FileConflicts[] {
  return plan
    .filter((p) => p.action === 'conflict')
    .map((p) => ({
      path: p.path,
      ...(p.binary ? { binary: true as const } : {}),
      regions: p.regions ?? [],
    }))
}

/** The plan as the result lists it: path, action and the conflict count. */
export function planFiles(
  plan: PlannedFile[],
): Array<{ path: string; action: PullFileAction; conflicts?: number }> {
  return plan.map(({ path, action, conflicts }) => ({
    path,
    action,
    ...(conflicts ? { conflicts } : {}),
  }))
}

export interface WriteOptions {
  cwd: string
  /** Write into files with uncommitted changes without asking. */
  yes?: boolean
  interactive?: boolean
  confirm?: (question: string) => Promise<boolean>
  /** The command to suggest with `--yes` when a dirty file stops the write. */
  command: string
}

/** Write the plan, after checking the developer's own git for uncommitted changes. */
export async function writePlan(options: WriteOptions, plan: PlannedFile[]): Promise<void> {
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
}

export function readWorkingFile(cwd: string, path: string): Uint8Array | undefined {
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

async function guardUncommittedChanges(options: WriteOptions, paths: string[]): Promise<void> {
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
    `These files have uncommitted changes: ${list}. Commit or stash them, or run \`${options.command} --yes\`.`,
    { exitCode: EXIT.refused },
  )
}
