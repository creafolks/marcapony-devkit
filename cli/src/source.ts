import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { isManifestV2, publicDirOf, serverPathOf, type MarcaponyConfig } from './config.js'
import type { SourceGrant } from './api.js'
import { decideIgnore, parseIgnoreRules, type IgnoreRule } from './ignore.js'
import {
  CREDENTIAL_FILE,
  FORBIDDEN_DIRS,
  MAX_SCAN_BYTES as MAX_SCAN_FILE_BYTES,
  blockingFindings,
  isUnscannable,
  scanText,
  type ScanFinding,
} from './scan-rules.js'

export { parseIgnoreRules, type IgnoreRule } from './ignore.js'

/**
 * Source collection and push for `marcapony app deploy`. The source goes to a git repo on the
 * platform through a short-lived write token; no git binary is involved and the
 * project's own `.git` is never touched: the throwaway repo lives in a temp
 * gitdir, with the project directory as its work tree.
 */

export const MAX_SOURCE_BYTES = 20 * 1024 * 1024
export const MAX_SOURCE_FILES = 5000

// Shared with the platform's scan (scan-rules.ts), so the CLI never pushes what
// the platform would block.
const ALWAYS_IGNORED_DIRS = new Set(FORBIDDEN_DIRS)
const ALWAYS_IGNORED_FILE = CREDENTIAL_FILE

/** First path segment of the build outputs named in marcapony.json. */
export function buildOutputDirs(config: MarcaponyConfig): string[] {
  const dirs = new Set<string>()
  for (const p of [serverPathOf(config), publicDirOf(config)]) {
    if (!p) continue
    const normalized = p.replace(/^\.\//, '')
    const dir = normalized.includes('/')
      ? dirname(normalized)
      : normalized === publicDirOf(config)
        ? normalized
        : null
    const first = dir?.split('/')[0]
    if (first && first !== '.') dirs.add(first)
  }
  return [...dirs]
}

function readRules(cwd: string, name: string, source = name, base = ''): IgnoreRule[] {
  try {
    return parseIgnoreRules(readFileSync(join(cwd, name), 'utf8'), source, base)
  } catch {
    return []
  }
}

export class SourceTooLargeError extends Error {}

export interface SkippedFile {
  path: string
  /** Why: `built-in`, `build output`, `symlink`, or the rule and the file it came from. */
  reason: string
}

export interface SourcePlan {
  files: string[]
  skipped: SkippedFile[]
}

/**
 * Every file that may leave the machine, and why each other one does not.
 * The order, as in git, lets a later source re-include with `!` what an
 * earlier one excluded: `.gitignore` files (root and nested) and
 * `.git/info/exclude`, then `.marcaponyignore` (version 1 projects), then the
 * manifest's `ignore`. Nothing re-includes the built-in list.
 */
export function planSourceFiles(cwd: string, config: MarcaponyConfig, explain = false): SourcePlan {
  const gitRules: IgnoreRule[] = [
    ...readRules(cwd, '.gitignore'),
    ...readRules(cwd, '.git/info/exclude', '.git/info/exclude'),
  ]
  const laterRules: IgnoreRule[] = [
    ...(isManifestV2(config) ? [] : readRules(cwd, '.marcaponyignore')),
    ...parseIgnoreRules((config.ignore ?? []).join('\n'), 'marcapony.json ignore'),
  ]
  const outputDirs = new Set(buildOutputDirs(config))
  const files: string[] = []
  const skipped: SkippedFile[] = []
  let total = 0

  const decide = (path: string, rules: IgnoreRule[]): IgnoreRule | null =>
    decideIgnore(path, [...rules, ...laterRules])
  const skip = (path: string, reason: string): void => {
    if (explain) skipped.push({ path, reason })
  }

  const walk = (rel: string, rules: IgnoreRule[]): void => {
    const nested = rel ? readRules(cwd, `${rel}/.gitignore`, `${rel}/.gitignore`, rel) : []
    const scope = nested.length > 0 ? [...rules, ...nested] : rules
    for (const entry of readdirSync(join(cwd, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        skip(path, 'symlink')
        continue
      }
      if (entry.isDirectory()) {
        if (ALWAYS_IGNORED_DIRS.has(entry.name)) {
          skip(`${path}/`, 'built-in')
          continue
        }
        if (!rel && outputDirs.has(entry.name)) {
          skip(`${path}/`, 'build output')
          continue
        }
        const rule = decide(`${path}/`, scope)
        if (rule) {
          skip(`${path}/`, `${rule.pattern} (${rule.source})`)
          continue
        }
        walk(path, scope)
        continue
      }
      if (!entry.isFile()) continue
      if (ALWAYS_IGNORED_FILE.test(entry.name)) {
        skip(path, 'built-in')
        continue
      }
      // The sync state of this checkout, not part of the app: pushing it would
      // make every pull of a teammate's deploy touch it.
      if (!rel && entry.name === 'marcapony.lock') {
        skip(path, 'built-in')
        continue
      }
      const rule = decide(path, scope)
      if (rule) {
        skip(path, `${rule.pattern} (${rule.source})`)
        continue
      }
      files.push(path)
      total += statSync(join(cwd, path)).size
      if (files.length > MAX_SOURCE_FILES) {
        throw new SourceTooLargeError(`Source has more than ${MAX_SOURCE_FILES} files`)
      }
      if (total > MAX_SOURCE_BYTES) {
        throw new SourceTooLargeError(
          `Source is larger than ${MAX_SOURCE_BYTES / 1024 / 1024} MB; add large files to "ignore" in marcapony.json`,
        )
      }
    }
  }
  walk('', gitRules)
  return { files: files.sort(), skipped }
}

/** Project-relative POSIX paths of every file that may leave the machine. */
export function collectSourceFiles(cwd: string, config: MarcaponyConfig): string[] {
  return planSourceFiles(cwd, config).files
}

export type { ScanFinding } from './scan-rules.js'

/**
 * The secret scan over the files a deploy would save. Returns every match,
 * the ones an allow comment or the test-fixture rule let through included
 * (marked `allowed`), so the push summary can list them. Binary files and
 * files over 1 MiB are not scanned.
 */
export function scanForSecrets(cwd: string, files: string[]): ScanFinding[] {
  const findings: ScanFinding[] = []
  for (const path of files) {
    let text: string
    let size: number
    try {
      size = statSync(join(cwd, path)).size
      if (size > MAX_SCAN_FILE_BYTES) continue
      text = readFileSync(join(cwd, path), 'utf8')
    } catch {
      continue
    }
    if (isUnscannable(text, size)) continue
    findings.push(...scanText(path, text, { side: 'cli' }))
  }
  return findings
}

export { blockingFindings }

/** One line per finding: `path:line  rule  value…`; the value is never shown in full. */
export function formatFinding(f: ScanFinding): string {
  return `${f.path}:${f.line}  ${f.rule}  ${f.masked}`
}

export interface PushSourceOptions {
  cwd: string
  files: string[]
  grant: SourceGrant
  /**
   * The commit the new one goes on top of: the project's base (the version
   * in `marcapony.lock`), or null for the first push to a branch. Never the remote head as
   * found at push time: that would silently replace changes this project has
   * not seen. A head that moved since the base makes git refuse the push.
   * Undefined on a platform older than the sync rule: the commit goes on top
   * of the remote head, as before it (none when the branch does not exist).
   */
  parent: string | null | undefined
  message?: string
  /**
   * The sha256 of the bundle this commit is deployed with (the server module,
   * then each public file, in upload order). Written as a `Bundle-Hash`
   * trailer so the platform can check that a CLI deploy's commit and bundle
   * belong together.
   */
  bundleHash?: string
  /** Injected in tests; defaults to isomorphic-git's network operations. */
  push?: typeof git.push
  fetch?: typeof git.fetch
}

/** `art_v1_<secret>?expires=<unix>`: git wants only the secret as password. */
export function tokenSecret(token: string): string {
  return token.split('?expires=')[0] as string
}

/** Git refused the push because the branch has commits the parent does not. */
export class SourcePushRejectedError extends Error {}

/** The commit message, with the `Bundle-Hash` trailer in its own last paragraph. */
export function commitMessage(message: string | undefined, bundleHash?: string): string {
  const subject = message?.trim() || 'marcapony app deploy'
  return bundleHash ? `${subject}\n\nBundle-Hash: ${bundleHash}\n` : subject
}

/**
 * Commit the collected files on top of `parent` and push. Returns the new
 * commit id. With a base, it fails closed: a fetch error is an error, never
 * "no parent". Without one (an older platform), a branch that cannot be
 * fetched is taken to be new.
 */
export async function pushSource(options: PushSourceOptions): Promise<string> {
  const { cwd, files, grant, parent } = options
  if (files.length === 0) throw new Error('No source files to push')
  const push = options.push ?? git.push
  const fetchRemote = options.fetch ?? git.fetch
  const gitdir = mkdtempSync(join(tmpdir(), 'marcapony-src-'))
  const onAuth = () => ({ username: 'x', password: tokenSecret(grant.token) })
  const common = { fs, dir: cwd, gitdir }

  try {
    await git.init({ ...common, defaultBranch: grant.branch })
    // A fresh gitdir has no remotes. isomorphic-git's fetch needs the remote's
    // refspec in the config to write refs/remotes/origin/*.
    await git.addRemote({ ...common, remote: 'origin', url: grant.remote })

    let commitParent = parent ?? null
    if (parent === undefined) {
      try {
        await fetchRemote({
          ...common,
          http,
          url: grant.remote,
          remote: 'origin',
          ref: grant.branch,
          singleBranch: true,
          tags: false,
          onAuth,
        })
        commitParent = await git.resolveRef({
          ...common,
          ref: `refs/remotes/origin/${grant.branch}`,
        })
      } catch {
        commitParent = null
      }
    } else if (parent) {
      // The parent's objects must be local for the commit and the pack.
      await fetchRemote({
        ...common,
        http,
        url: grant.remote,
        remote: 'origin',
        ref: grant.branch,
        singleBranch: true,
        tags: false,
        onAuth,
      })
      try {
        await git.readCommit({ ...common, oid: parent })
      } catch {
        throw new SourcePushRejectedError(
          `Your base ${parent.slice(0, 7)} is no longer on the branch. Run \`marcapony app pull\`.`,
        )
      }
    }

    for (const filepath of files) await git.add({ ...common, filepath })
    const oid = await git.commit({
      ...common,
      ref: `refs/heads/${grant.branch}`,
      message: commitMessage(options.message, options.bundleHash),
      author: { name: 'Marcapony CLI', email: 'cli@marcapony.com' },
      parent: commitParent ? [commitParent] : [],
    })

    try {
      await push({
        ...common,
        http,
        url: grant.remote,
        ref: grant.branch,
        remoteRef: grant.branch,
        onAuth,
      })
    } catch (err) {
      const e = err as { code?: string; data?: { reason?: string } }
      if (e?.code === 'PushRejectedError') {
        throw new SourcePushRejectedError(
          'Someone pushed to this environment while you were building. Run `marcapony app pull`.',
        )
      }
      throw err
    }
    return oid
  } finally {
    rmSync(gitdir, { recursive: true, force: true })
  }
}

/**
 * Fetch the environment branch with a read token and return the files of a
 * commit (`marcapony app pull`). The temp gitdir is gone before this returns.
 */
export async function readRemoteFiles(options: {
  grant: { remote: string; branch: string; token: string }
  commits: Array<string | null>
  fetch?: typeof git.fetch
}): Promise<Array<Map<string, Uint8Array> | null>> {
  const gitdir = mkdtempSync(join(tmpdir(), 'marcapony-pull-'))
  const fetchRemote = options.fetch ?? git.fetch
  const common = { fs, gitdir }
  try {
    await git.init({ ...common, bare: true, defaultBranch: options.grant.branch })
    await git.addRemote({ ...common, remote: 'origin', url: options.grant.remote })
    await fetchRemote({
      ...common,
      http,
      url: options.grant.remote,
      remote: 'origin',
      ref: options.grant.branch,
      singleBranch: true,
      tags: false,
      onAuth: () => ({ username: 'x', password: tokenSecret(options.grant.token) }),
    })
    const out: Array<Map<string, Uint8Array> | null> = []
    for (const commit of options.commits) {
      if (!commit) {
        out.push(new Map())
        continue
      }
      try {
        const files = new Map<string, Uint8Array>()
        const paths = await git.listFiles({ ...common, ref: commit })
        for (const filepath of paths) {
          const { blob } = await git.readBlob({ ...common, oid: commit, filepath })
          files.set(filepath, blob)
        }
        out.push(files)
      } catch {
        out.push(null)
      }
    }
    return out
  } finally {
    rmSync(gitdir, { recursive: true, force: true })
  }
}
