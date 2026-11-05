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
