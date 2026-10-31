import { exchangeCode, fetchCapabilities } from './api.js'
import { renderAgents, writeAgentsFile } from './agents.js'
import {
  detectDefaults,
  ensureEnvFileIgnored,
  readConfig,
  readEnvFile,
  resolveApiRoot,
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
 * environment key and write it straight into `.dev.vars`. The raw key never
 * passes through a human clipboard and is never printed.
 */
export async function runLink(options: LinkOptions): Promise<void> {
  const log = options.log ?? console.log
  const apiRoot = resolveApiRoot(options.cliEnv)
  const prompt = options.prompt ?? terminalPrompt

  const code = (options.code ?? (await prompt('Pairing code: '))).trim()
  if (!code) throw new Error('A pairing code is required. Generate one from the app page.')

  const result = await exchangeCode(apiRoot, code, options.fetchImpl ?? fetch)

  // Ignore before writing: if this throws, no key has hit the disk yet.
  const newlyIgnored = ensureEnvFileIgnored(options.cwd)

  writeEnvFile(
    options.cwd,
    upsertEnvLines(readEnvFile(options.cwd), {
      MARCAPONY_API_KEY: result.key,
      MARCAPONY_API_URL: result.baseUrl,
    }),
  )

  const existing = readConfig(options.cwd)
  const detected = detectDefaults(options.cwd)
  // Start from the existing file so fields link does not own (placement,
  // permissions) survive a re-link; dropping them would make the next deploy
  // forget the app's portal placement and permission list.
  const config: MarcaponyConfig = {
    ...existing,
    app: existing?.app ?? result.appSlug ?? 'app',
    build: existing?.build ?? 'bun run build',
    worker: existing?.worker ?? detected.worker,
    ...((existing?.assets ?? detected.assets)
      ? { assets: existing?.assets ?? detected.assets }
      : {}),
    ...(existing?.assetsConfig ? { assetsConfig: existing.assetsConfig } : {}),
    ...(existing?.compatibilityDate ? { compatibilityDate: existing.compatibilityDate } : {}),
    ...(existing?.compatibilityFlags ? { compatibilityFlags: existing.compatibilityFlags } : {}),
  }
  writeConfig(options.cwd, config)

  log(`Linked to ${config.app} (${result.environmentName}).`)
  log(`  .dev.vars       MARCAPONY_API_KEY, MARCAPONY_API_URL written`)
  if (newlyIgnored) log(`  .gitignore      .dev.vars added — it holds a live key, never commit it`)
  log(`  marcapony.json  build "${config.build}", worker "${config.worker}"`)

  // Write AGENTS.md so the project's AI assistant has the exact SDK calls +
  // schemas for this app's features. Best-effort: the key and config are
  // already written, so a capabilities hiccup must not fail the link.
  try {
    const capabilities = await fetchCapabilities(apiRoot, result.key, options.fetchImpl ?? fetch)
    writeAgentsFile(options.cwd, renderAgents({ appName: config.app, capabilities }))
    log(`  AGENTS.md       ${capabilities.length} operation(s) documented for your AI assistant`)
  } catch (err) {
    log(
      `  AGENTS.md       skipped (${err instanceof Error ? err.message : 'could not fetch capabilities'})`,
    )
  }

  log(`Next: marcapony app deploy`)
}
