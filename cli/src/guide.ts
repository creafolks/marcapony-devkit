import { fetchCapabilities } from './api.js'
import { renderAgents } from './agents.js'
import { readConfig, resolveApiKey, resolveApiRoot } from './config.js'

export interface GuideOptions {
  cwd: string
  /** Hidden team override: local | staging | production (defaults to production). */
  cliEnv?: string
  env: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  log?: (message: string) => void
}

/**
 * `marcapony guide` — print the AI-readable setup guide for this project (the
 * same content `marcapony app link` writes to AGENTS.md) to stdout, so it can
 * be piped into an assistant or re-generated on demand. Uses the linked key to
 * fetch this app's scope-filtered capability catalog.
 */
export async function runGuide(options: GuideOptions): Promise<void> {
  const log = options.log ?? console.log
  const apiRoot = resolveApiRoot(options.cliEnv)
  const apiKey = resolveApiKey(options.cwd, options.env)
  const appName = readConfig(options.cwd)?.app ?? 'your app'

  const capabilities = apiKey
    ? await fetchCapabilities(apiRoot, apiKey, options.fetchImpl ?? fetch)
    : []

  log(renderAgents({ appName, capabilities }))
}
