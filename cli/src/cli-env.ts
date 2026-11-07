import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_FILE, isCliEnv } from './config.js'
import { PROJECT_LINK_DIR } from './project-link.js'

/**
 * `.marcapony/cli.json`: the `--cli-env` a project was linked with, so later
 * commands in it keep talking to the same API instead of falling back to
 * production. An explicit `--cli-env` always wins and is saved again.
 */
export const CLI_ENV_FILE = 'cli.json'

export function readSavedCliEnv(cwd: string): string | undefined {
  const path = join(cwd, PROJECT_LINK_DIR, CLI_ENV_FILE)
  if (!existsSync(path)) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { cliEnv?: unknown }
    return typeof value.cliEnv === 'string' && isCliEnv(value.cliEnv) ? value.cliEnv : undefined
  } catch {
    return undefined
  }
}

export function saveCliEnv(cwd: string, cliEnv: string): void {
  if (!isCliEnv(cliEnv)) return
  mkdirSync(join(cwd, PROJECT_LINK_DIR), { recursive: true })
  writeFileSync(
    join(cwd, PROJECT_LINK_DIR, CLI_ENV_FILE),
    `${JSON.stringify({ cliEnv }, null, 2)}\n`,
  )
}

/** Login runs anywhere; it saves the choice only inside a project folder. */
export function isProjectFolder(cwd: string): boolean {
  return existsSync(join(cwd, CONFIG_FILE)) || existsSync(join(cwd, PROJECT_LINK_DIR))
}
