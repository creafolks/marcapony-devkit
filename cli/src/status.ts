import { CliError, EXIT, fetchSourceHead, type SourceHead } from './api.js'
import { readConfig, resolveApiKey, resolveApiRoot } from './config.js'
import { readBase } from './lock.js'

export interface StatusResult {
  app: string
  branch: string | null
  storesSource: boolean
  head: string | null
  base: string | null
  scan: SourceHead['scan']
  movedBy: SourceHead['movedBy']
  state: 'up_to_date' | 'behind' | 'not_synced' | 'no_source'
  next: string | null
}

/**
 * `marcapony app status`: the environment's branch head as the platform
 * tracks it, this project's base from `marcapony.lock`, and the next command
 * to run.
 */
export async function runStatus(options: {
  cwd: string
  cliEnv?: string
  env: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  log?: (message: string) => void
}): Promise<StatusResult> {
  const log = options.log ?? console.log
  const config = readConfig(options.cwd)
  const apiKey = resolveApiKey(options.cwd, options.env)
  if (!config || !apiKey) {
    throw new CliError('This project is not linked. Run `marcapony app link` first.', {
      exitCode: EXIT.notLinked,
    })
  }
  const head = await fetchSourceHead(resolveApiRoot(options.cliEnv), apiKey, options.fetchImpl)
  if (!head?.enabled || !head.environmentId) {
    log(`${config.app}: this environment does not store source.`)
    return {
      app: config.app,
      branch: head?.branch ?? null,
      storesSource: false,
      head: null,
      base: null,
      scan: null,
      movedBy: null,
      state: 'no_source',
      next: null,
    }
  }
  const entry = readBase(options.cwd, head.environmentId)
  const base = entry?.base ? (head.rewrites[entry.base] ?? entry.base) : (entry?.base ?? null)
  const state: StatusResult['state'] =
    head.head === null || (entry && base === head.head)
      ? 'up_to_date'
      : entry
        ? 'behind'
        : 'not_synced'
  const next = state === 'up_to_date' ? null : 'marcapony app pull'

  log(`App          ${config.app} (branch ${head.branch})`)
  log(
    `Platform     ${head.head ? head.head.slice(0, 7) : 'no source yet'}${head.stale ? ' (could not refresh)' : ''}`,
  )
  if (head.movedBy) {
    log(
      `             version ${head.movedBy.version} by ${head.movedBy.name ?? 'someone'}${head.movedBy.forced ? ', forced' : ''}`,
    )
  }
  log(`This project ${entry ? (base ? base.slice(0, 7) : 'no base') : 'never synced'}`)
  if (head.scan) log(`Check        ${head.scan}`)
  log(next ? `Next         ${next}` : 'Up to date.')
  return {
    app: config.app,
    branch: head.branch,
    storesSource: true,
    head: head.head,
    base,
    scan: head.scan,
    movedBy: head.movedBy,
    state,
    next,
  }
}
