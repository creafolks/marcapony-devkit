import { execSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { collectAssets } from './assets.js'
import { createDeployment, fetchDeployment, fetchSourceGrant, type DeploymentView } from './api.js'
import { readConfig, resolveApiKey, resolveApiRoot } from './config.js'
import { collectSourceFiles, pushSource, scanForSecrets, type PushSourceOptions } from './source.js'

export interface DeployOptions {
  cwd: string
  /** Hidden team override: local | staging | production (defaults to production). */
  cliEnv?: string
  env: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  /** Injected in tests so no real build runs. */
  runBuild?: (command: string, cwd: string) => void
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  /** Version message stored with the source commit. */
  message?: string
  /** Injected in tests so no real git push happens. */
  pushSourceImpl?: (options: PushSourceOptions) => Promise<string>
}

/** Source push is off unless MARCAPONY_SOURCE_PUSH=1 (spike, phase A1). */
function sourcePushEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.MARCAPONY_SOURCE_PUSH === '1'
}

const POLL_INTERVAL_MS = 2000
const POLL_ATTEMPTS = 60

function defaultRunBuild(command: string, cwd: string): void {
  execSync(command, { cwd, stdio: 'inherit' })
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `marcapony app deploy` — build locally, upload the bundle, wait for the
 * platform to put it live. The environment is derived from the key, so there is
 * no --env flag: deploying with the test key targets the test environment.
 * wrangler and git are never involved.
 */
export async function runDeploy(options: DeployOptions): Promise<DeploymentView> {
  const log = options.log ?? console.log
  const config = readConfig(options.cwd)
  if (!config) {
    throw new Error(`No marcapony.json found. Run \`marcapony app link\` first.`)
  }

  const apiKey = resolveApiKey(options.cwd, options.env)
  if (!apiKey) {
    throw new Error(
      'No MARCAPONY_API_KEY found in the environment or .dev.vars. Run `marcapony app link` first.',
    )
  }
  const apiRoot = resolveApiRoot(options.cliEnv)

  const sourceFiles = sourcePushEnabled(options.env) ? safeCollect(options.cwd, config, log) : null

  log(`Building: ${config.build}`)
  ;(options.runBuild ?? defaultRunBuild)(config.build, options.cwd)

  const workerPath = join(options.cwd, config.worker)
  if (!existsSync(workerPath)) {
    throw new Error(
      `Worker module not found at ${config.worker}. Check the "worker" path in marcapony.json.`,
    )
  }
  const worker = readFileSync(workerPath).toString('base64')

  let assets: ReturnType<typeof collectAssets> | undefined
  if (config.assets) {
    const assetsPath = join(options.cwd, config.assets)
    if (!existsSync(assetsPath) || !statSync(assetsPath).isDirectory()) {
      throw new Error(
        `Assets directory not found at ${config.assets}. Check the "assets" path in marcapony.json.`,
      )
    }
    assets = collectAssets(assetsPath)
    log(`Uploading worker + ${assets.length} asset(s)`)
  } else {
    log('Uploading worker')
  }

  // An empty list would commit an empty tree on top of the stored source and
  // wipe it (an allowlist .gitignore whose negations we skip ends up here).
  if (sourceFiles && sourceFiles.length > 0) {
    await trySourcePush({ options, apiRoot, apiKey, files: sourceFiles, log })
  } else if (sourceFiles) {
    log('Source not saved: no files left after the ignore rules')
  }

  let deployment = await createDeployment(
    apiRoot,
    apiKey,
    {
      worker: { main: 'index.js', content: worker, encoding: 'base64' },
      ...(config.compatibilityDate ? { compatibilityDate: config.compatibilityDate } : {}),
      ...(config.compatibilityFlags ? { compatibilityFlags: config.compatibilityFlags } : {}),
      ...(assets ? { assets } : {}),
      ...(config.assetsConfig ? { assetsConfig: config.assetsConfig } : {}),
      ...(config.placement ? { placement: config.placement } : {}),
      ...(config.dataAccess ? { dataAccess: config.dataAccess } : {}),
      ...(config.permissions
        ? { permissions: config.permissions.map((p) => ({ ...p, grants: p.grants ?? [] })) }
        : {}),
      ...(config.portal ? { portal: config.portal } : {}),
    },
    options.fetchImpl ?? fetch,
  )

  const sleep = options.sleep ?? defaultSleep
  for (let i = 0; deployment.status === 'uploading' && i < POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS)
    deployment = await fetchDeployment(apiRoot, apiKey, deployment.id, options.fetchImpl ?? fetch)
  }

  if (deployment.status === 'failed') {
    throw new Error(`Deploy failed: ${deployment.error ?? 'unknown error'}`)
  }
  if (deployment.status === 'uploading') {
    throw new Error(
      `Deploy did not finish in time. Check status later: deployment ${deployment.id}`,
    )
  }

  // Local dev is served over plain http (wrangler dev has no TLS); a
  // platform-issued hostname is always https. Match localhost / 127.0.0.1 as
  // the actual host (minus any port), not as a substring of a real hostname.
  if (deployment.hostname) {
    const host = deployment.hostname.replace(/:\d+$/, '')
    const local = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1'
    log(`Live: ${local ? 'http' : 'https'}://${deployment.hostname}`)
  } else {
    log(`Live (deployment ${deployment.id})`)
  }
  return deployment
}

function safeCollect(
  cwd: string,
  config: NonNullable<ReturnType<typeof readConfig>>,
  log: (message: string) => void,
): string[] | null {
  try {
    return collectSourceFiles(cwd, config)
  } catch (err) {
    log(`Warning: source not saved (${err instanceof Error ? err.message : String(err)})`)
    return null
  }
}

/**
 * Spike behaviour: nothing in here may fail the deploy. A secret finding skips
 * the push (phase A2 turns it into a hard stop); any other failure is a warning.
 */
async function trySourcePush(args: {
  options: DeployOptions
  apiRoot: string
  apiKey: string
  files: string[]
  log: (message: string) => void
}): Promise<void> {
  const { options, apiRoot, apiKey, files, log } = args
  try {
    const findings = scanForSecrets(options.cwd, files)
    if (findings.length > 0) {
      for (const f of findings) log(`Secret scan: ${f.rule} in ${f.path}:${f.line}`)
      log('Warning: source not saved because the secret scan found possible secrets')
      return
    }
    const grant = await fetchSourceGrant(apiRoot, apiKey, options.fetchImpl ?? fetch)
    if (!grant) return
    const push = options.pushSourceImpl ?? pushSource
    await push({ cwd: options.cwd, files, grant, message: options.message })
    log(`Source saved (${files.length} file(s), branch ${grant.branch})`)
  } catch (err) {
    log(`Warning: source not saved (${err instanceof Error ? err.message : String(err)})`)
  }
}
