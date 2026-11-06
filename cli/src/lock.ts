import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `marcapony.lock`: the commit this project last synced with, per environment.
 * It holds no secret and is meant to be committed in the team's own repo, so a
 * fresh checkout, a CI runner and every agent worktree share the same base.
 * `marcapony app deploy` and `marcapony app pull` update it.
 */
export const LOCK_FILE = 'marcapony.lock'

export interface LockEntry {
  base: string | null
  syncedAt: string
}

export interface LockFile {
  environments: Record<string, LockEntry>
}

export function readLock(cwd: string): LockFile {
  const path = join(cwd, LOCK_FILE)
  if (!existsSync(path)) return { environments: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockFile>
    return { environments: { ...(parsed.environments ?? {}) } }
  } catch {
    throw new Error(
      `${LOCK_FILE} is not valid JSON. Fix it, or delete it and run \`marcapony app pull\`.`,
    )
  }
}

/** The environment's entry; undefined when this project never synced with it. */
export function readBase(cwd: string, environmentId: string): LockEntry | undefined {
  return readLock(cwd).environments[environmentId]
}

/** Keys are sorted so two developers on different environments merge the file trivially. */
export function writeBase(
  cwd: string,
  environmentId: string,
  base: string | null,
  now = new Date(),
): void {
  const lock = readLock(cwd)
  lock.environments[environmentId] = { base, syncedAt: now.toISOString() }
  const environments = Object.fromEntries(
    Object.entries(lock.environments).sort(([a], [b]) => a.localeCompare(b)),
  )
  writeFileSync(join(cwd, LOCK_FILE), `${JSON.stringify({ environments }, null, 2)}\n`)
}

const SHA = /^[0-9a-f]{40}$/

/**
 * The commit the project's own git repo has checked out, read from `.git`
 * without a git binary: a detached HEAD, a loose ref or a packed one. Null
 * when the project is not a git repo or the ref cannot be resolved.
 */
export function localGitHead(cwd: string): string | null {
  const gitDir = join(cwd, '.git')
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    if (SHA.test(head)) return head
    const ref = /^ref: (refs\/[^\s]+)$/.exec(head)?.[1]
    if (!ref || ref.split('/').includes('..')) return null
    const loose = join(gitDir, ref)
    if (existsSync(loose)) {
      const sha = readFileSync(loose, 'utf8').trim()
      return SHA.test(sha) ? sha : null
    }
    const packed = join(gitDir, 'packed-refs')
    if (!existsSync(packed)) return null
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(' ')
      if (sha && name === ref && SHA.test(sha)) return sha
    }
    return null
  } catch {
    return null
  }
}
