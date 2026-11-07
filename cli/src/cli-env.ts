import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_FILE, cliEnvOfApiRoot, isCliEnv, readLinkedApiUrl } from './config.js'
import { PROJECT_LINK_DIR, readProjectLink } from './project-link.js'

/**
 * `.marcapony/cli.json`: the `--cli-env` a project was linked with, so later
 * commands in it keep talking to the same API instead of falling back to
 * production. An explicit `--cli-env` always wins and is saved again.
 * Without `cli.json` the project's existing link answers: the API root in
 * `.marcapony/project.json` (a login link from before this file existed), or
 * `MARCAPONY_API_URL` next to a folder's key (a pairing-code link).
 */
export const CLI_ENV_FILE = 'cli.json'

export function readSavedCliEnv(cwd: string): string | undefined {
  const path = join(cwd, PROJECT_LINK_DIR, CLI_ENV_FILE)
  if (!existsSync(path)) {
    const linked = linkedApiUrl(cwd)
    return linked ? cliEnvOfApiRoot(linked) : undefined
  }
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

/**
 * Login runs anywhere: it saves the choice only inside a project folder, and
 * only one that has no API yet. It never moves a project linked elsewhere;
 * `app link` does that.
 */
export function saveLoginCliEnv(cwd: string, cliEnv: string): void {
  const isProject = existsSync(join(cwd, CONFIG_FILE)) || existsSync(join(cwd, PROJECT_LINK_DIR))
  if (!isProject) return
  // Any existing link, even to an API this CLI does not know, keeps its API.
  if (existsSync(join(cwd, PROJECT_LINK_DIR, CLI_ENV_FILE)) || linkedApiUrl(cwd)) return
  saveCliEnv(cwd, cliEnv)
}

function linkedApiUrl(cwd: string): string | null {
  return readProjectLink(cwd)?.apiRoot ?? readLinkedApiUrl(cwd)
}
