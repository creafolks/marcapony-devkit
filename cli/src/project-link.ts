import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `.marcapony/project.json`: which app and environment a project linked with
 * `marcapony login` deploys to. Ids only, no secret: the deploy credential
 * comes from the login, exchanged per command.
 */
export interface ProjectLink {
  apiRoot: string
  accountId: string
  accountSlug: string | null
  appId: string
  appSlug: string
  environment: string
}

export const PROJECT_LINK_DIR = '.marcapony'
export const PROJECT_LINK_FILE = 'project.json'

export function readProjectLink(cwd: string): ProjectLink | null {
  const path = join(cwd, PROJECT_LINK_DIR, PROJECT_LINK_FILE)
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProjectLink>
    if (!value.apiRoot || !value.accountId || !value.appId || !value.environment) return null
    return value as ProjectLink
  } catch {
    return null
  }
}

export function writeProjectLink(cwd: string, link: ProjectLink): void {
  mkdirSync(join(cwd, PROJECT_LINK_DIR), { recursive: true })
  writeFileSync(
    join(cwd, PROJECT_LINK_DIR, PROJECT_LINK_FILE),
    `${JSON.stringify(link, null, 2)}\n`,
  )
}
