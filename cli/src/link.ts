import {
  CliError,
  EXIT,
  exchangeCode,
  fetchCapabilities,
  fetchSourceHead,
  retirePreviousKeys,
} from './api.js'
import { pickLogin, type CredentialDeps } from './credentials.js'
import { fetchLinkableApps, mintDevKey, revokeOldKey, type LinkableApp } from './login-api.js'
import { LoginIndex } from './login-store.js'
import { writeProjectLink } from './project-link.js'
import { renderAgents, writeAgentsFile } from './agents.js'
import {
  NEWEST_RUNTIME,
  SCHEMA_REF,
  detectDefaults,
  ensureEnvFileIgnored,
  envFileOf,
  isManifestV2,
  parseEnvLines,
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
  /** Linking with a login: the app (slug or id) and environment; asked when omitted. */
  app?: string
  envName?: string
  /** The business, when logged in to several. */
  account?: string
  /** Move a project linked with a pairing code to the login. */
  refresh?: boolean
  /** Tests stand in for the login index and keychain. */
  credentialDeps?: CredentialDeps
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

  // Logged in: no pairing code, and no deploy key in the folder.
  const index = options.credentialDeps?.index ?? new LoginIndex()
  if (options.refresh || (!options.code && !options.ci && index.forApi(apiRoot).length > 0)) {
    await runLoginLink({ ...options, log, prompt, apiRoot, index })
    return
  }

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

interface LoginLinkContext extends LinkOptions {
  log: (message: string) => void
  prompt: (question: string) => Promise<string>
  apiRoot: string
  index: LoginIndex
}

async function choose<T>(
  items: T[],
  label: (item: T) => string,
  what: string,
  prompt: (question: string) => Promise<string>,
  log: (message: string) => void,
): Promise<T> {
  if (items.length === 1) return items[0]!
  for (const [i, item] of items.entries()) log(`  ${i + 1}. ${label(item)}`)
  const answer = Number.parseInt(await prompt(`${what} (1-${items.length}): `), 10)
  const picked = items[answer - 1]
  if (!picked) throw new CliError(`No ${what.toLowerCase()} picked.`, { exitCode: EXIT.failed })
  return picked
}

/**
 * Linking with `marcapony login`: lists the business's apps through the
 * login, writes the app and environment ids to `.marcapony/project.json`, and
 * a data-only key (no deploy, no source) into `.env.local` for local runs.
 * Deploys exchange the login for a one-hour key each time. With --refresh, a
 * project linked with a pairing code moves over and its old deploy key is
 * revoked.
 */
async function runLoginLink(options: LoginLinkContext): Promise<void> {
  const { log, prompt, apiRoot } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const login = await pickLogin(apiRoot, {
    account: options.account,
    ...options.credentialDeps,
    index: options.index,
  })
  const existing = readConfig(options.cwd)
  const oldKey = options.refresh ? currentFolderKey(options.cwd, existing) : null
  if (options.refresh && !oldKey) {
    throw new CliError(
      'There is no deploy key in this folder to replace. Run `marcapony app link`.',
      {
        exitCode: EXIT.notLinked,
      },
    )
  }

  const apps = await fetchLinkableApps(apiRoot, login.credential, fetchImpl)
  if (apps.length === 0) {
    throw new CliError('This business has no apps yet. Create one in the dashboard first.', {
      exitCode: EXIT.failed,
    })
  }
  const wantedApp = options.app ?? (options.refresh ? existing?.app : undefined)
  const app: LinkableApp = wantedApp
    ? (apps.find((a) => a.slug === wantedApp || a.id === wantedApp) ??
      fail(`No app ${wantedApp} in this business.`))
    : await choose(apps, (a) => `${a.name} (${a.slug})`, 'App', prompt, log)

  let envName = options.envName
  if (!envName && oldKey) {
    // The old key knows its environment; the source route says which one.
    const head = await fetchSourceHead(apiRoot, oldKey, fetchImpl).catch(() => null)
    envName = app.environments.find((e) => e.id === head?.environmentId)?.name
  }
  const environment = envName
    ? (app.environments.find((e) => e.name === envName) ??
      fail(`No environment ${envName} in ${app.slug}.`))
    : await choose(app.environments, (e) => e.name, 'Environment', prompt, log)

  const devKey = await mintDevKey(
    apiRoot,
    login.credential,
    { appId: app.id, environment: environment.name },
    fetchImpl,
  )
  const { envFile, newlyIgnored } = writeLinkedKey(options.cwd, existing, devKey)
  writeProjectLink(options.cwd, {
    apiRoot,
    accountId: login.record.accountId,
    accountSlug: login.record.accountSlug,
    appId: app.id,
    appSlug: app.slug,
    environment: environment.name,
  })

  const detected = detectDefaults(options.cwd)
  const config: MarcaponyConfig = existing
    ? { ...existing, app: app.slug, build: existing.build ?? 'bun run build' }
    : {
        $schema: SCHEMA_REF,
        manifest: 2,
        app: app.slug,
        build: 'bun run build',
        server: detected.server,
        ...(detected.publicDir ? { public: { dir: detected.publicDir } } : {}),
        runtime: NEWEST_RUNTIME,
        ignore: ['coverage/', '*.log'],
      }
  writeConfig(options.cwd, config)

  log(
    `Linked to ${app.slug} (${environment.name}) with your login to ${login.record.accountName ?? login.record.accountSlug ?? 'this business'}.`,
  )
  log('  .marcapony/project.json  app and environment ids (commit it, it holds no secret)')
  log(`  ${envFile.padEnd(14)} a data-only key for local runs; it cannot deploy`)
  if (newlyIgnored) log(`  .gitignore     ${envFile} added; never commit it`)

  if (oldKey) {
    try {
      await revokeOldKey(apiRoot, login.credential, oldKey, fetchImpl)
      log('  Old deploy key revoked')
    } catch (err) {
      log(
        `  Old deploy key not revoked (${err instanceof Error ? err.message : 'request failed'}); revoke it from the app page`,
      )
    }
  }

  await writeAgentsBestEffort(options.cwd, config.app, devKey.key, envFile, apiRoot, fetchImpl, log)
  log('Next: marcapony app deploy')
}

function fail(message: string): never {
  throw new CliError(message, { exitCode: EXIT.failed })
}

/** The deploy key `marcapony app link` wrote into this folder, if any. */
function currentFolderKey(cwd: string, config: MarcaponyConfig | null): string | null {
  return parseEnvLines(readEnvFile(cwd, envFileOf(cwd, config))).MARCAPONY_API_KEY ?? null
}
