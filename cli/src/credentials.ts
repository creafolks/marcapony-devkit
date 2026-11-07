import { CliError, EXIT } from './api.js'
import { resolveApiKey } from './config.js'
import { mintSessionKey } from './login-api.js'
import {
  LoginIndex,
  configDir,
  secretKey,
  storeFor,
  type LoginRecord,
  type SecretStore,
} from './login-store.js'
import { readProjectLink, type ProjectLink } from './project-link.js'

/**
 * Which credential a command deploys and pushes with:
 * 1. `MARCAPONY_API_KEY` from the process environment (CI and agents);
 * 2. the `marcapony login` credential, exchanged for a one-hour session key,
 *    when the project was linked with a login (`.marcapony/project.json`);
 * 3. the deploy key `marcapony app link` wrote into `.env.local` (projects
 *    linked with a pairing code).
 */

export interface CredentialDeps {
  index?: LoginIndex
  /** Resolves the secret store a record lives in; tests pass an in-memory one. */
  store?: (record: LoginRecord) => Promise<SecretStore | null>
  fetchImpl?: typeof fetch
}

export function loginRequired(message?: string): CliError {
  return new CliError(
    message ?? 'Not logged in, or the login expired or was revoked. Run `marcapony login`.',
    { code: 'login_required', exitCode: EXIT.loginRequired },
  )
}

/** The login and its secret for an account on an API root, or null. */
export async function loadLogin(
  apiRoot: string,
  accountId: string,
  deps: CredentialDeps = {},
): Promise<{ record: LoginRecord; credential: string } | null> {
  const index = deps.index ?? new LoginIndex()
  const record = index.find(apiRoot, accountId)
  if (!record) return null
  const store = await (deps.store ?? ((r: LoginRecord) => storeFor(r.storage, configDir())))(record)
  const credential = store ? await store.get(secretKey(record)) : null
  return credential ? { record, credential } : null
}

/**
 * The login a command without a linked project uses: the one for the
 * account named, else the only login on this API root.
 */
export async function pickLogin(
  apiRoot: string,
  options: { account?: string; project?: ProjectLink | null } & CredentialDeps,
): Promise<{ record: LoginRecord; credential: string }> {
  const index = options.index ?? new LoginIndex()
  const logins = index.forApi(apiRoot)
  const wanted = options.project?.accountId
    ? logins.filter((r) => r.accountId === options.project?.accountId)
    : options.account
      ? logins.filter((r) => r.accountSlug === options.account || r.accountId === options.account)
      : logins
  if (wanted.length === 0) throw loginRequired()
  if (wanted.length > 1) {
    throw new CliError(
      `You are logged in to several businesses (${wanted
        .map((r) => r.accountSlug ?? r.accountId)
        .join(', ')}). Pass --account <slug>.`,
      { exitCode: EXIT.failed },
    )
  }
  const loaded = await loadLogin(apiRoot, wanted[0]!.accountId, { ...options, index })
  if (!loaded) throw loginRequired()
  return loaded
}

const sessionCache = new Map<string, string>()

/**
 * The deploy key for a command, by the precedence above, or null when the
 * project is not linked at all. A project linked with a login whose login is
 * gone fails with exit code 7.
 */
export async function resolveDeployKey(
  options: { cwd: string; env: NodeJS.ProcessEnv; apiRoot: string } & CredentialDeps,
): Promise<string | null> {
  if (options.env.MARCAPONY_API_KEY) return options.env.MARCAPONY_API_KEY
  const project = readProjectLink(options.cwd)
  if (project && project.apiRoot === options.apiRoot) {
    const cacheKey = `${project.apiRoot}|${project.appId}|${project.environment}`
    const cached = sessionCache.get(cacheKey)
    if (cached) return cached
    const login = await loadLogin(project.apiRoot, project.accountId, options)
    if (!login) {
      throw loginRequired(
        `This project deploys with your login to ${project.accountSlug ?? 'its business'}. Run \`marcapony login\`.`,
      )
    }
    const minted = await mintSessionKey(
      project.apiRoot,
      login.credential,
      { appId: project.appId, environment: project.environment },
      options.fetchImpl,
    )
    sessionCache.set(cacheKey, minted.key)
    return minted.key
  }
  return resolveApiKey(options.cwd, options.env)
}

/** For tests: forget the session keys minted in this process. */
export function clearSessionCache(): void {
  sessionCache.clear()
}

/** What `marcapony login status` reports for the current project. */
export function describeProjectCredential(
  cwd: string,
  env: NodeJS.ProcessEnv,
  apiRoot: string,
): string {
  if (env.MARCAPONY_API_KEY) return 'MARCAPONY_API_KEY from the environment'
  const project = readProjectLink(cwd)
  if (project && project.apiRoot === apiRoot) {
    return `your login to ${project.accountSlug ?? project.accountId} (${project.appSlug}, ${project.environment})`
  }
  if (resolveApiKey(cwd, env))
    return 'the deploy key in this folder (run `marcapony app link --refresh` to use your login)'
  return 'none: this folder is not linked'
}
