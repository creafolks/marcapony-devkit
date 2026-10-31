import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import type { MarcaponyConfig } from './config.js'
import type { SourceGrant } from './api.js'

/**
 * Source collection and push for `marcapony app deploy`. The source goes to a git repo on the
 * platform through a short-lived write token; no git binary is involved and the
 * project's own `.git` is never touched: the throwaway repo lives in a temp
 * gitdir, with the project directory as its work tree.
 */

export const MAX_SOURCE_BYTES = 20 * 1024 * 1024
export const MAX_SOURCE_FILES = 5000

const ALWAYS_IGNORED_DIRS = new Set(['node_modules', '.git', '.wrangler'])
// Files that hold credentials by convention; never read, whatever the ignore
// rules say. `.dev.vars.<env>` is wrangler's per-environment variant.
const ALWAYS_IGNORED_FILE =
  /^(\.dev\.vars(\..*)?|\.env(\..*)?|\.npmrc|\.netrc|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_(rsa|dsa|ecdsa|ed25519))$/

export type IgnoreRule = { test: (path: string) => boolean }

function globToRegexSource(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return out
}

/**
 * A pragmatic subset of gitignore: comments, `*`, `**`, `?`, a leading `/` or a
 * middle `/` to anchor, a trailing `/` for directories. Negation (`!`) is not
 * supported and its line is skipped, which keeps the file excluded: the safe
 * direction for a secret-bearing upload.
 */
export function parseIgnoreRules(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of content.split('\n')) {
    let line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    const anchored = line.startsWith('/') || line.includes('/')
    line = line.replace(/^\/+/, '')
    if (!line) continue
    const body = globToRegexSource(line)
    const prefix = anchored ? '^' : '^(?:.*/)?'
    const suffix = dirOnly ? '/.*$' : '(?:/.*)?$'
    const re = new RegExp(`${prefix}${body}${suffix}`)
    rules.push({ test: (path) => re.test(path) })
  }
  return rules
}

/** First path segment of the build outputs named in marcapony.json. */
export function buildOutputDirs(config: Pick<MarcaponyConfig, 'worker' | 'assets'>): string[] {
  const dirs = new Set<string>()
  for (const p of [config.worker, config.assets]) {
    if (!p) continue
    const normalized = p.replace(/^\.\//, '')
    const dir = normalized.includes('/') ? dirname(normalized) : null
    const first = dir?.split('/')[0]
    if (first && first !== '.') dirs.add(first)
  }
  return [...dirs]
}

function readRules(cwd: string, name: string): IgnoreRule[] {
  try {
    return parseIgnoreRules(readFileSync(join(cwd, name), 'utf8'))
  } catch {
    return []
  }
}

export class SourceTooLargeError extends Error {}

/** Project-relative POSIX paths of every file that may leave the machine. */
export function collectSourceFiles(
  cwd: string,
  config: Pick<MarcaponyConfig, 'worker' | 'assets'>,
): string[] {
  const rules = [...readRules(cwd, '.gitignore'), ...readRules(cwd, '.marcaponyignore')]
  const outputDirs = new Set(buildOutputDirs(config))
  const files: string[] = []
  let total = 0

  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(cwd, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (ALWAYS_IGNORED_DIRS.has(entry.name)) continue
        if (!rel && outputDirs.has(entry.name)) continue
        if (rules.some((r) => r.test(`${path}/`))) continue
        walk(path)
        continue
      }
      if (!entry.isFile()) continue
      if (ALWAYS_IGNORED_FILE.test(entry.name)) continue
      if (rules.some((r) => r.test(path))) continue
      files.push(path)
      total += statSync(join(cwd, path)).size
      if (files.length > MAX_SOURCE_FILES) {
        throw new SourceTooLargeError(`Source has more than ${MAX_SOURCE_FILES} files`)
      }
      if (total > MAX_SOURCE_BYTES) {
        throw new SourceTooLargeError(
          `Source is larger than ${MAX_SOURCE_BYTES / 1024 / 1024} MB; add large files to .marcaponyignore`,
        )
      }
    }
  }
  walk('')
  return files.sort()
}

export interface SecretFinding {
  path: string
  line: number
  rule: string
}

const SECRET_RULES: Array<{ rule: string; re: RegExp }> = [
  { rule: 'Marcapony API key', re: /\bmpk_[A-Za-z0-9]{16,}/ },
  { rule: 'Stripe-style secret key', re: /\bsk_(live|test)_[A-Za-z0-9]{16,}/ },
  { rule: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'Private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'GCP service account JSON', re: /"type"\s*:\s*"service_account"/ },
]

/**
 * Stub of the §3.3 scan: known key formats only, no entropy heuristics, no
 * provider-specific rules (Iyzico, PayTR). Reports file and line, never the
 * value. The full scan and the server-side re-scan land in phase A2.
 */
export function scanForSecrets(cwd: string, files: string[]): SecretFinding[] {
  const findings: SecretFinding[] = []
  for (const path of files) {
    let text: string
    try {
      text = readFileSync(join(cwd, path), 'utf8')
    } catch {
      continue
    }
    if (text.includes('\u0000')) continue
    text.split('\n').forEach((line, index) => {
      for (const { rule, re } of SECRET_RULES) {
        if (re.test(line)) findings.push({ path, line: index + 1, rule })
      }
    })
  }
  return findings
}

export interface PushSourceOptions {
  cwd: string
  files: string[]
  grant: SourceGrant
  message?: string
  /** Injected in tests; defaults to isomorphic-git's network operations. */
  push?: typeof git.push
  fetch?: typeof git.fetch
}

/** `art_v1_<secret>?expires=<unix>`: git wants only the secret as password. */
export function tokenSecret(token: string): string {
  return token.split('?expires=')[0] as string
}

/**
 * Commit the collected files on top of the remote branch (when it exists) and
 * push. Returns the new commit id.
 */
export async function pushSource(options: PushSourceOptions): Promise<string> {
  const { cwd, files, grant } = options
  if (files.length === 0) throw new Error('No source files to push')
  const push = options.push ?? git.push
  const fetchRemote = options.fetch ?? git.fetch
  const gitdir = mkdtempSync(join(tmpdir(), 'marcapony-src-'))
  const onAuth = () => ({ username: 'x', password: tokenSecret(grant.token) })
  const common = { fs, dir: cwd, gitdir }

  try {
    await git.init({ ...common, defaultBranch: grant.branch })
    // A fresh gitdir has no remotes. isomorphic-git's fetch needs the remote's
    // refspec in the config to write refs/remotes/origin/*; without it the
    // fetch fails, the commit gets no parent and every push after the first is
    // rejected as non-fast-forward.
    await git.addRemote({ ...common, remote: 'origin', url: grant.remote })

    let parent: string[] = []
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
      parent = [await git.resolveRef({ ...common, ref: `refs/remotes/origin/${grant.branch}` })]
    } catch {
      parent = []
    }

    for (const filepath of files) await git.add({ ...common, filepath })
    const oid = await git.commit({
      ...common,
      ref: `refs/heads/${grant.branch}`,
      message: options.message?.trim() || 'marcapony app deploy',
      author: { name: 'Marcapony CLI', email: 'cli@marcapony.com' },
      ...(parent.length > 0 ? { parent } : {}),
    })

    await push({
      ...common,
      http,
      url: grant.remote,
      ref: grant.branch,
      remoteRef: grant.branch,
      onAuth,
    })
    return oid
  } finally {
    rmSync(gitdir, { recursive: true, force: true })
  }
}
