import { exchangeCode, fetchCapabilities } from './api.js'
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

  const result = await exchangeCode(apiRoot, code, options.fetchImpl ?? fetch)

  const existing = readConfig(options.cwd)
  // A project linked before version 2 keeps its file; everything new gets
  // `.env.local`.
  const envFile = envFileOf(options.cwd, existing)

  // Ignore before writing: if this throws, no key has hit the disk yet.
  const newlyIgnored = ensureEnvFileIgnored(options.cwd, envFile)

  writeEnvFile(
    options.cwd,
    upsertEnvLines(readEnvFile(options.cwd, envFile), {
      MARCAPONY_API_KEY: result.key,
      MARCAPONY_API_URL: result.baseUrl,
    }),
    envFile,
  )

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
  if (newlyIgnored) log(`  .gitignore     ${envFile} added; it holds a live key, never commit it`)
  log(`  marcapony.json build "${config.build}", server "${serverPathOf(config)}"`)
  if (existing && !isManifestV2(existing)) {
    log('  Tip: `marcapony app migrate-config` moves marcapony.json to the current format.')
  }

  // Write AGENTS.md so the project's AI assistant has the exact SDK calls +
  // schemas for this app's features. Best-effort: the key and config are
  // already written, so a capabilities hiccup must not fail the link.
  try {
    const capabilities = await fetchCapabilities(apiRoot, result.key, options.fetchImpl ?? fetch)
    writeAgentsFile(options.cwd, renderAgents({ appName: config.app, capabilities, envFile }))
    log(`  AGENTS.md       ${capabilities.length} operation(s) documented for your AI assistant`)
  } catch (err) {
    log(
      `  AGENTS.md       skipped (${err instanceof Error ? err.message : 'could not fetch capabilities'})`,
    )
  }

  log(`Next: marcapony app deploy`)
}
