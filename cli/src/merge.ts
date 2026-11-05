import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Three-way merge for `marcapony app pull`. When a `git` binary is on the PATH,
 * each file goes through `git merge-file --diff3`, so the markers are git's own.
 * Otherwise a small vendored merge on a Myers line diff writes the same marker
 * format, which keeps the CLI at one dependency.
 */

export interface MergeLabels {
  ours: string
  base: string
  theirs: string
}

export interface MergeResult {
  text: string
  conflicts: number
}

/** One changed region: `a[aStart, aStart+aLen)` became `b[bStart, bStart+bLen)`. */
export interface Hunk {
  aStart: number
  aLen: number
  bStart: number
  bLen: number
}

/** Myers O((N+M)D) diff on lines, returned as changed regions in order. */
export function diffLines(a: string[], b: string[]): Hunk[] {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = false
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = true
        break
      }
    }
  }

  // Walk the trace back into a list of equal-line pairs.
  const matches: Array<[number, number]> = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]!
    const k = x - y
    const prevK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : vd[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      matches.push([x, y])
    }
    if (d > 0) {
      x = prevX
      y = prevY
    }
  }
  while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
    x--
    y--
    matches.push([x, y])
  }
  matches.reverse()

  const hunks: Hunk[] = []
  let ai = 0
  let bi = 0
  for (const [ma, mb] of [...matches, [n, m] as [number, number]]) {
    if (ma > ai || mb > bi) hunks.push({ aStart: ai, aLen: ma - ai, bStart: bi, bLen: mb - bi })
    ai = ma + 1
    bi = mb + 1
  }
  return hunks
}

export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return ''
  return lines.join('\n') + (trailingNewline ? '\n' : '')
}

interface SideHunk {
  side: 'ours' | 'theirs'
  baseStart: number
  baseLen: number
  lines: string[]
}

/** The side's version of base[start, end), given that side's hunks inside the region. */
function sideOfRegion(base: string[], hunks: SideHunk[], start: number, end: number): string[] {
  const out: string[] = []
  let p = start
  for (const h of hunks) {
    while (p < h.baseStart) out.push(base[p++]!)
    out.push(...h.lines)
    p = h.baseStart + h.baseLen
  }
  while (p < end) out.push(base[p++]!)
  return out
}

/**
 * diff3 merge of `ours` and `theirs` against `base`. Overlapping or touching
 * changes from both sides are a conflict unless both made the same change.
 */
export function mergeText(
  ours: string,
  base: string,
  theirs: string,
  labels: MergeLabels,
): MergeResult {
  const o = splitLines(ours)
  const b = splitLines(base)
  const t = splitLines(theirs)
  const hunks: SideHunk[] = [
    ...diffLines(b, o).map((h) => ({
      side: 'ours' as const,
      baseStart: h.aStart,
      baseLen: h.aLen,
      lines: o.slice(h.bStart, h.bStart + h.bLen),
    })),
    ...diffLines(b, t).map((h) => ({
      side: 'theirs' as const,
      baseStart: h.aStart,
      baseLen: h.aLen,
      lines: t.slice(h.bStart, h.bStart + h.bLen),
    })),
  ].sort((x, y) => x.baseStart - y.baseStart || (x.side === 'ours' ? -1 : 1))

  const out: string[] = []
  let conflicts = 0
  let cursor = 0
  for (let i = 0; i < hunks.length; ) {
    const regionStart = hunks[i]!.baseStart
    let regionEnd = regionStart + hunks[i]!.baseLen
    let j = i + 1
    while (j < hunks.length && hunks[j]!.baseStart <= regionEnd) {
      regionEnd = Math.max(regionEnd, hunks[j]!.baseStart + hunks[j]!.baseLen)
      j++
    }
    const group = hunks.slice(i, j)
    while (cursor < regionStart) out.push(b[cursor++]!)

    const oursHunks = group.filter((h) => h.side === 'ours')
    const theirsHunks = group.filter((h) => h.side === 'theirs')
    const oursLines = sideOfRegion(b, oursHunks, regionStart, regionEnd)
    const theirsLines = sideOfRegion(b, theirsHunks, regionStart, regionEnd)
    if (oursHunks.length === 0) out.push(...theirsLines)
    else if (theirsHunks.length === 0) out.push(...oursLines)
    else if (oursLines.join('\n') === theirsLines.join('\n')) out.push(...oursLines)
    else {
      conflicts++
      out.push(`<<<<<<< ${labels.ours}`, ...oursLines)
      out.push(`||||||| ${labels.base}`, ...b.slice(regionStart, regionEnd))
      out.push('=======', ...theirsLines, `>>>>>>> ${labels.theirs}`)
    }
    cursor = regionEnd
    i = j
  }
  while (cursor < b.length) out.push(b[cursor++]!)

  const trailing = [theirs, ours, base].some((s) => s.endsWith('\n')) || out.length === 0
  return { text: joinLines(out, trailing), conflicts }
}

/** True when `git` can be run. Probed once per process. */
let gitAvailable: boolean | undefined
export function hasGitBinary(): boolean {
  if (gitAvailable === undefined) {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
      gitAvailable = true
    } catch {
      gitAvailable = false
    }
  }
  return gitAvailable
}

/** `git merge-file -p --diff3`, whose exit status is the number of conflicts. */
export function mergeWithGit(
  ours: string,
  base: string,
  theirs: string,
  labels: MergeLabels,
): MergeResult {
  const dir = mkdtempSync(join(tmpdir(), 'marcapony-merge-'))
  try {
    const paths = { ours: join(dir, 'ours'), base: join(dir, 'base'), theirs: join(dir, 'theirs') }
    writeFileSync(paths.ours, ours)
    writeFileSync(paths.base, base)
    writeFileSync(paths.theirs, theirs)
    const args = [
      'merge-file',
      '-p',
      '--diff3',
      '-L',
      labels.ours,
      '-L',
      labels.base,
      '-L',
      labels.theirs,
      paths.ours,
      paths.base,
      paths.theirs,
    ]
    try {
      const text = execFileSync('git', args, { encoding: 'utf8' })
      return { text, conflicts: 0 }
    } catch (err) {
      const e = err as { status?: number; stdout?: string }
      if (typeof e.status === 'number' && e.status > 0 && typeof e.stdout === 'string') {
        return { text: e.stdout, conflicts: e.status }
      }
      throw err
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function mergeFile(
  ours: string,
  base: string,
  theirs: string,
  labels: MergeLabels,
  useGit = hasGitBinary(),
): MergeResult {
  if (useGit) {
    try {
      return mergeWithGit(ours, base, theirs, labels)
    } catch {
      // A git that cannot run merge-file falls back to the vendored merge.
    }
  }
  return mergeText(ours, base, theirs, labels)
}

/** A unified diff of one file, for `marcapony app pull --patch`. */
export function unifiedDiff(
  path: string,
  before: string | null,
  after: string | null,
  context = 3,
): string {
  const a = splitLines(before ?? '')
  const b = splitLines(after ?? '')
  const hunks = diffLines(a, b)
  if (hunks.length === 0) return ''
  const header = [
    `diff --git a/${path} b/${path}`,
    before === null ? '--- /dev/null' : `--- a/${path}`,
    after === null ? '+++ /dev/null' : `+++ b/${path}`,
  ]
  const blocks: string[] = []
  let i = 0
  while (i < hunks.length) {
    let j = i
    while (
      j + 1 < hunks.length &&
      hunks[j + 1]!.aStart - (hunks[j]!.aStart + hunks[j]!.aLen) <= context * 2
    ) {
      j++
    }
    const first = hunks[i]!
    const last = hunks[j]!
    const aFrom = Math.max(0, first.aStart - context)
    const aTo = Math.min(a.length, last.aStart + last.aLen + context)
    const bFrom = Math.max(0, first.bStart - context)
    const bTo = Math.min(b.length, last.bStart + last.bLen + context)
    const lines: string[] = []
    let ap = aFrom
    for (const h of hunks.slice(i, j + 1)) {
      while (ap < h.aStart) lines.push(` ${a[ap++]}`)
      for (let k = 0; k < h.aLen; k++) lines.push(`-${a[h.aStart + k]}`)
      for (let k = 0; k < h.bLen; k++) lines.push(`+${b[h.bStart + k]}`)
      ap = h.aStart + h.aLen
    }
    while (ap < aTo) lines.push(` ${a[ap++]}`)
    blocks.push(`@@ -${aFrom + 1},${aTo - aFrom} +${bFrom + 1},${bTo - bFrom} @@`, ...lines)
    i = j + 1
  }
  return `${[...header, ...blocks].join('\n')}\n`
}

/** Git's conflict markers at the start of a line, as a pull leaves them. */
export const CONFLICT_MARKER = /^(<{7}|>{7}) /m

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
