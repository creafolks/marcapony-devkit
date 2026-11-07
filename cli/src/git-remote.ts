import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CliError, EXIT, fetchSourceHead, fetchSourceReadGrant } from './api.js'
import { CONFIG_FILE, resolveApiKey, resolveApiRoot } from './config.js'
import { pickLogin, type CredentialDeps } from './credentials.js'
import { PROJECT_LINK_DIR, readProjectLink } from './project-link.js'

/**
 * A real git remote: `git push` and `git fetch` against Marcapony, with the
 * CLI as git's credential helper. `marcapony app remote add` writes the remote
 * and the helper into the repository's own git config (never the global one);
 * `marcapony git-credential` hands git a 15-minute git session, minted from
 * the login or the project's deploy key, each time git asks.
 */

/** Where each API's git remote lives. The local API has none. */
const GIT_HOSTS: Record<string, string> = {
  'https://api.marcapony.com': 'git.marcapony.com',
  'https://staging-api.marcapony.com': 'staging-git.marcapony.com',
}

export const DEFAULT_REMOTE_NAME = 'marcapony'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function gitHostOf(apiRoot: string): string | null {
  return GIT_HOSTS[new URL(apiRoot).origin] ?? null
}

export function apiRootOfGitHost(host: string): string | null {
  const bare = host.toLowerCase().replace(/:443$/, '')
  return Object.entries(GIT_HOSTS).find(([, h]) => h === bare)?.[0] ?? null
}

/** The branch an environment's source lives on; the platform names it the same way. */
export function branchOfEnvironment(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned.length > 0 ? cleaned : 'main'
}

/** The app id in a remote path: `<appId>.git` or `<appId>`, with or without a leading slash. */
export function appIdOfPath(path: string | undefined): string | null {
  if (!path) return null
  const last = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/').pop() ?? ''
  const id = last.replace(/\.git$/, '')
  return UUID.test(id) ? id.toLowerCase() : null
}

/** The nearest directory at or above `cwd` that holds a linked project. */
export function findProjectRoot(cwd: string): string | null {
  let dir = cwd
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE)) || existsSync(join(dir, PROJECT_LINK_DIR))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export interface GitSession {
  username: string
  password: string
  expiresAt: string
  remote: string
  environmentId: string | null
}

/** `POST /ext/v1/git/sessions`, with a login credential or a deploy key as the bearer. */
export async function mintGitSession(
  apiRoot: string,
  bearer: string,
  appId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitSession> {
  const res = await fetchImpl(`${apiRoot}/ext/v1/git/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ appId }),
  })
  if (res.ok) return ((await res.json()) as { data: GitSession }).data
  type ErrorBody = { error?: { code?: string; message?: string } }
  let body: ErrorBody | null = null
  try {
    body = (await res.json()) as ErrorBody
  } catch {
    body = null
  }
  const code = body?.error?.code
  const message = body?.error?.message ?? `Request failed with status ${res.status}`
  if (res.status === 404 && !code) {
    throw new CliError('This platform has no git remote yet.', {
      status: 404,
      exitCode: EXIT.refused,
    })
  }
  throw new CliError(code ? `${message} (${code})` : message, { code, status: res.status })
}

type GitRunner = (args: string[], cwd: string) => { status: number; stdout: string; stderr: string }

const runGit: GitRunner = (args, cwd) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.error) {
    throw new CliError('git is not installed or not on the PATH.', { exitCode: EXIT.failed })
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export interface RemoteDeps extends CredentialDeps {
  git?: GitRunner
  /** The command git runs as the helper; resolved from this process by default. */
  helperCommand?: string
}

/**
 * How git should start this CLI as its helper: `marcapony` when it is on the
 * PATH, otherwise this very installation, so a CLI run through `bunx` or `npx`
 * still answers.
 */
export function defaultHelperCommand(): string {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['marcapony'], {
    encoding: 'utf8',
  })
  if (which.status === 0 && which.stdout.trim()) return '!marcapony git-credential'
  const entry = process.argv[1] ? realpathSync(process.argv[1]) : null
  if (!entry) return '!marcapony git-credential'
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return `!${quote(process.execPath)} ${quote(entry)} git-credential`
}

interface LinkedTarget {
  apiRoot: string
  appId: string
  /** The environment a push goes to by default. */
  environment: string
  branch: string
  /** A deploy key pushes only to its own environment. */
  pinned: boolean
}

/** Which app and environment the project in `cwd` is linked to. */
async function linkedTarget(
  options: { cwd: string; cliEnv?: string; env: NodeJS.ProcessEnv } & CredentialDeps,
): Promise<LinkedTarget> {
  const apiRoot = resolveApiRoot(options.cliEnv)
  const project = readProjectLink(options.cwd)
  if (project && project.apiRoot === apiRoot) {
    return {
      apiRoot,
      appId: project.appId,
      environment: project.environment,
      branch: branchOfEnvironment(project.environment),
      pinned: false,
    }
  }
  const key = resolveApiKey(options.cwd, options.env)
  if (!key) {
    throw new CliError('This folder is not linked. Run `marcapony app link` first.', {
      exitCode: EXIT.notLinked,
    })
  }
  const head = (await fetchSourceHead(apiRoot, key, options.fetchImpl)) as
    | (Awaited<ReturnType<typeof fetchSourceHead>> & { appId?: string; environmentName?: string })
    | null
  let appId = head?.appId ?? null
  if (!appId) {
    // A platform that does not say the app id in the head: the read remote does.
    const grant = await fetchSourceReadGrant(apiRoot, key, options.fetchImpl)
    appId = appIdOfPath(grant ? new URL(grant.remote).pathname : undefined)
  }
  if (!appId || !head) {
    throw new CliError("The platform did not say which app this folder's key belongs to.", {
      exitCode: EXIT.refused,
    })
  }
  return {
    apiRoot,
    appId,
    environment: head.environmentName ?? head.branch,
    branch: head.branch,
    pinned: true,
  }
}

export interface RemoteAddResult {
  remote: string
  url: string
  branch: string
  environment: string
  created: boolean
}

/** `marcapony app remote add [--env <name>] [--name marcapony]` */
export async function runRemoteAdd(
  options: {
    cwd: string
    cliEnv?: string
    env: NodeJS.ProcessEnv
    envName?: string
    name?: string
    log: (message: string) => void
  } & RemoteDeps,
): Promise<RemoteAddResult> {
  const git = options.git ?? runGit
  const name = options.name ?? DEFAULT_REMOTE_NAME
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new CliError(`"${name}" is not a usable remote name.`, { exitCode: EXIT.failed })
  }
  const inside = git(['rev-parse', '--is-inside-work-tree'], options.cwd)
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    throw new CliError('This folder is not a git repository. Run `git init` first.', {
      exitCode: EXIT.failed,
    })
  }
  const target = await linkedTarget(options)
  const host = gitHostOf(target.apiRoot)
  if (!host) {
    throw new CliError('This API has no git remote.', { exitCode: EXIT.failed })
  }
  const environment = options.envName ?? target.environment
  if (target.pinned && options.envName && branchOfEnvironment(options.envName) !== target.branch) {
    throw new CliError(
      `This folder's deploy key pushes only to ${target.environment}. Run \`marcapony login\` and link with it to push to ${options.envName}.`,
      { exitCode: EXIT.refused },
    )
  }
  const branch = options.envName ? branchOfEnvironment(options.envName) : target.branch

  // A session proves the credential works here before anything is written,
  // and the platform names the remote. Its password is not kept.
  const bearers = await credentialsFor(target.apiRoot, options.cwd, options.env, options)
  if (bearers.length === 0) {
    throw new CliError('Not logged in, and this folder has no deploy key. Run `marcapony login`.', {
      code: 'login_required',
      exitCode: EXIT.loginRequired,
    })
  }
  const session = await mintWithAny(target.apiRoot, bearers, target.appId, options.fetchImpl)
  const url = session.remote

  const existing = git(['remote', 'get-url', name], options.cwd)
  const created = existing.status !== 0
  const steps: string[][] = [
    created ? ['remote', 'add', name, url] : ['remote', 'set-url', name, url],
    ['config', '--replace-all', `remote.${name}.push`, `HEAD:refs/heads/${branch}`],
    // An empty helper first resets the list, so a global helper (the macOS
    // keychain, say) neither answers nor keeps the 15-minute password.
    ['config', '--unset-all', `credential.https://${host}.helper`],
    ['config', '--add', `credential.https://${host}.helper`, ''],
    [
      'config',
      '--add',
      `credential.https://${host}.helper`,
      options.helperCommand ?? defaultHelperCommand(),
    ],
    ['config', `credential.https://${host}.useHttpPath`, 'true'],
  ]
  for (const args of steps) {
    const result = git(args, options.cwd)
    // Unsetting a key that is not there exits 5; nothing to undo.
    if (result.status !== 0 && !(args[1] === '--unset-all' && result.status === 5)) {
      throw new CliError(`git ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim()}`, {
        exitCode: EXIT.failed,
      })
    }
  }
  if (environment === 'production') {
    options.log(
      'Pushes to production are taken only while the app does not go live through releases.',
    )
  }
  options.log(`Remote ${name} pushes HEAD to ${branch} (${environment}).`)
  options.log(`Next: git push ${name}`)
  return { remote: name, url, branch, environment, created }
}

/** `marcapony app remote remove [--name marcapony]` */
export async function runRemoteRemove(options: {
  cwd: string
  name?: string
  log: (message: string) => void
  git?: GitRunner
}): Promise<{ remote: string; removed: boolean }> {
  const git = options.git ?? runGit
  const name = options.name ?? DEFAULT_REMOTE_NAME
  const existing = git(['remote', 'get-url', name], options.cwd)
  if (existing.status !== 0) {
    options.log(`There is no remote named ${name}.`)
    return { remote: name, removed: false }
  }
  let host: string | null = null
  try {
    host = new URL(existing.stdout.trim()).host
  } catch {
    host = null
  }
  const removed = git(['remote', 'remove', name], options.cwd)
  if (removed.status !== 0) {
    throw new CliError(`git remote remove failed: ${removed.stderr.trim()}`, {
      exitCode: EXIT.failed,
    })
  }
  // The helper lines stay while another remote still uses the same host.
  if (host && apiRootOfGitHost(host)) {
    const others = git(['remote', '-v'], options.cwd).stdout.includes(`://${host}/`)
    if (!others) {
      git(['config', '--unset-all', `credential.https://${host}.helper`], options.cwd)
      git(['config', '--unset', `credential.https://${host}.useHttpPath`], options.cwd)
      git(['config', '--remove-section', `credential.https://${host}`], options.cwd)
    }
  }
  options.log(`Removed the remote ${name}.`)
  return { remote: name, removed: true }
}

/**
 * The bearers a git session may be minted with, best first:
 * 1. `MARCAPONY_API_KEY` from the environment when it is not the folder's own
 *    key (CI and agents);
 * 2. in a folder linked with a login (`.marcapony/project.json` for this
 *    API), that login, then the folder's key;
 * 3. in a folder linked with a deploy key, that key, then a login: a login
 *    to another business must not stand in for the folder's own key;
 * 4. with no link, the only login for this API.
 * A folder's data-only dev key is refused by the platform, which says so.
 */
async function credentialsFor(
  apiRoot: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  deps: CredentialDeps,
): Promise<string[]> {
  const out: string[] = []
  const folderKey = resolveApiKey(cwd, {})
  if (env.MARCAPONY_API_KEY && env.MARCAPONY_API_KEY !== folderKey) out.push(env.MARCAPONY_API_KEY)
  const project = readProjectLink(cwd)
  const linkedWithLogin = project !== null && project.apiRoot === apiRoot
  const login = async (): Promise<string | null> => {
    try {
      return (await pickLogin(apiRoot, { ...deps, project: linkedWithLogin ? project : null }))
        .credential
    } catch (err) {
      // No login, or several without a linked project to choose from.
      if (!(err instanceof CliError)) throw err
      return null
    }
  }
  const order = linkedWithLogin ? [await login(), folderKey] : [folderKey, await login()]
  for (const bearer of order) if (bearer && !out.includes(bearer)) out.push(bearer)
  return out
}

/** Mint with each bearer in turn; a 404 (not this app's credential) moves on to the next. */
async function mintWithAny(
  apiRoot: string,
  bearers: string[],
  appId: string,
  fetchImpl?: typeof fetch,
): Promise<GitSession> {
  let last: unknown = null
  for (const bearer of bearers) {
    try {
      return await mintGitSession(apiRoot, bearer, appId, fetchImpl)
    } catch (err) {
      last = err
      if (!(err instanceof CliError && err.status === 404 && err.code)) throw err
    }
  }
  throw last
}

/** Git's credential protocol: `key=value` lines, ended by a blank line or EOF. */
export function parseCredentialRequest(input: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of input.split(/\r?\n/)) {
    if (line === '') break
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

/**
 * `marcapony git-credential <get|store|erase>`. Prints only the credential on
 * stdout; anything for the person goes to stderr, which git shows. With no
 * credential to offer, `get` prints nothing and exits 0, so git falls back to
 * its other helpers or a prompt.
 */
export async function runGitCredential(
  options: {
    action: string | undefined
    cwd: string
    env: NodeJS.ProcessEnv
    input: string
    write: (text: string) => void
    warn: (message: string) => void
  } & CredentialDeps,
): Promise<number> {
  if (options.action === 'store' || options.action === 'erase') return EXIT.ok
  if (options.action !== 'get') {
    options.warn('Usage: marcapony git-credential <get|store|erase>')
    return EXIT.failed
  }
  const request = parseCredentialRequest(options.input)
  if (request.protocol && request.protocol !== 'https') return EXIT.ok
  const apiRoot = request.host ? apiRootOfGitHost(request.host) : null
  if (!apiRoot) return EXIT.ok
  const appId = appIdOfPath(request.path)
  if (!appId) {
    options.warn(
      'marcapony: git did not say which app this is. Run `marcapony app remote add` again.',
    )
    return EXIT.ok
  }
  const cwd = findProjectRoot(options.cwd) ?? options.cwd
  const bearers = await credentialsFor(apiRoot, cwd, options.env, options)
  if (bearers.length === 0) {
    options.warn(
      'marcapony: not logged in, and this folder has no deploy key. Run `marcapony login`.',
    )
    return EXIT.ok
  }
  try {
    const session = await mintWithAny(apiRoot, bearers, appId, options.fetchImpl)
    const expiry = Math.floor(new Date(session.expiresAt).getTime() / 1000)
    options.write(
      `username=${session.username}\npassword=${session.password}\n${
        Number.isFinite(expiry) ? `password_expiry_utc=${expiry}\n` : ''
      }`,
    )
    return EXIT.ok
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    options.warn(`marcapony: ${message}`)
    return err instanceof CliError ? err.exitCode : EXIT.failed
  }
}
