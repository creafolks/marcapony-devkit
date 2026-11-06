import { exchangeCode, fetchCapabilities, retirePreviousKeys } from './api.js'
import { renderAgents, writeAgentsFile } from './agents.js'
import {
  NEWEST_RUNTIME,
  SCHEMA_REF,
  detectDefaults,
  ensureEnvFileIgnored,
  envFileOf,
  isManifestV2,
  readConfig,
  readEnvFile,
  resolveApiRoot,
  serverPathOf,
  upsertEnvLines,
  writeConfig,
  writeEnvFile,
  type MarcaponyConfig,
} from './config.js'

export interface LinkOptions {
  cwd: string
  code?: string
  /** Hidden team override: local | staging | production (defaults to production). */
  cliEnv?: string
  env: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  /** Injected in tests; defaults to a terminal prompt. */
  prompt?: (question: string) => Promise<string>
  log?: (message: string) => void
  /** A key for a pipeline: labelled CI, and earlier keys stay valid. */
  ci?: boolean
}

async function terminalPrompt(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

/**
 * `marcapony app link` — exchange a one-time pairing code for this project's
 * environment key and write it straight into `.env.local` (`.dev.vars` in a
 * project linked before manifest version 2). The raw key never
 * passes through a human clipboard and is never printed.
 */
export async function runLink(options: LinkOptions): Promise<void> {
  const log = options.log ?? console.log
  const apiRoot = resolveApiRoot(options.cliEnv)
  const prompt = options.prompt ?? terminalPrompt

  const code = (options.code ?? (await prompt('Pairing code: '))).trim()
  if (!code) throw new Error('A pairing code is required. Generate one from the app page.')

  const fetchImpl = options.fetchImpl ?? fetch
  const result = await exchangeCode(apiRoot, code, fetchImpl, { ci: options.ci === true })

  const existing = readConfig(options.cwd)
  const { envFile, newlyIgnored } = writeLinkedKey(options.cwd, existing, result)

  const detected = detectDefaults(options.cwd)
  // Start from the existing file so fields link does not own (placement,
  // permissions) survive a re-link; dropping them would make the next deploy
  // forget the app's portal placement and permission list. A new project gets
  // a version 2 manifest.
  const app = existing?.app ?? result.appSlug ?? 'app'
  const config: MarcaponyConfig = existing
    ? { ...existing, app, build: existing.build ?? 'bun run build' }
    : {
        $schema: SCHEMA_REF,
        manifest: 2,
        app,
        build: 'bun run build',
        server: detected.server,
        ...(detected.publicDir ? { public: { dir: detected.publicDir } } : {}),
        runtime: NEWEST_RUNTIME,
        ignore: ['coverage/', '*.log'],
      }
  if (existing && !isManifestV2(existing) && !existing.worker) config.worker = detected.server
  writeConfig(options.cwd, config)

  log(`Linked to ${config.app} (${result.environmentName}).`)
  log(`  ${envFile.padEnd(14)} MARCAPONY_API_KEY, MARCAPONY_API_URL written`)
  if (result.expiresAt)
    log(`  Key expires    ${result.expiresAt.slice(0, 10)}; link again to renew it`)
  if (options.ci) {
    log(
      `  CI key         store MARCAPONY_API_KEY from ${envFile} in your pipeline's secret store, then remove it from this machine`,
    )
  } else {
    await retireEarlierKeys(apiRoot, result.key, fetchImpl, log)
  }
  if (newlyIgnored) log(`  .gitignore     ${envFile} added; it holds a live key, never commit it`)
  log(`  marcapony.json build "${config.build}", server "${serverPathOf(config)}"`)
  if (existing && !isManifestV2(existing)) {
    log('  Tip: `marcapony app migrate-config` moves marcapony.json to the current format.')
  }

  await writeAgentsBestEffort(options.cwd, config.app, result.key, envFile, apiRoot, fetchImpl, log)

  log(`Next: marcapony app deploy`)
}

/**
 * Write the key into the project's env file, ignored by git before anything
 * is written: if that throws, no key has hit the disk. A project linked
 * before manifest version 2 keeps `.dev.vars`; everything new gets `.env.local`.
 */
export function writeLinkedKey(
  cwd: string,
  existing: MarcaponyConfig | null,
  result: { key: string; baseUrl: string },
): { envFile: string; newlyIgnored: boolean } {
  const envFile = envFileOf(cwd, existing)
  const newlyIgnored = ensureEnvFileIgnored(cwd, envFile)
  writeEnvFile(
    cwd,
    upsertEnvLines(readEnvFile(cwd, envFile), {
      MARCAPONY_API_KEY: result.key,
      MARCAPONY_API_URL: result.baseUrl,
    }),
    envFile,
  )
  return { envFile, newlyIgnored }
}

/**
 * The new key is on disk, so the ones it replaces can go. A platform older
 * than rotation answers null and keeps them.
 */
export async function retireEarlierKeys(
  apiRoot: string,
  key: string,
  fetchImpl: typeof fetch,
  log: (message: string) => void,
): Promise<void> {
  try {
    const revoked = await retirePreviousKeys(apiRoot, key, fetchImpl)
    if (revoked)
      log(`  Earlier keys   ${revoked} of your previous key(s) for this environment revoked`)
  } catch (err) {
    log(
      `  Earlier keys   not revoked (${err instanceof Error ? err.message : 'request failed'}); revoke them from the app page`,
    )
  }
}

/**
 * AGENTS.md gives the project's AI assistant the exact SDK calls and schemas
 * for this app's features. Best effort: the key is already written, so a
 * capabilities hiccup must not fail the command.
 */
export async function writeAgentsBestEffort(
  cwd: string,
  appName: string,
  key: string,
  envFile: string,
  apiRoot: string,
  fetchImpl: typeof fetch,
  log: (message: string) => void,
): Promise<void> {
  try {
    const capabilities = await fetchCapabilities(apiRoot, key, fetchImpl)
    writeAgentsFile(cwd, renderAgents({ appName, capabilities, envFile }))
    log(`  AGENTS.md       ${capabilities.length} operation(s) documented for your AI assistant`)
  } catch (err) {
    log(
      `  AGENTS.md       skipped (${err instanceof Error ? err.message : 'could not fetch capabilities'})`,
    )
  }
}
