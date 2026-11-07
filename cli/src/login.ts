import { spawn } from 'node:child_process'
import { arch, hostname, platform } from 'node:os'
import { CliError, EXIT } from './api.js'
import { resolveApiRoot } from './config.js'
import { describeProjectCredential, loadLogin, loginRequired, pickLogin } from './credentials.js'
import { pollDeviceToken, requestDeviceCode, revokeCurrentLogin } from './login-api.js'
import {
  LoginIndex,
  configDir,
  fileStore,
  keychainStore,
  secretKey,
  storeFor,
  type LoginRecord,
  type SecretStore,
} from './login-store.js'
import { readProjectLink } from './project-link.js'

export interface LoginOptions {
  cliEnv?: string
  /** The business to log in to; the approval page asks the person to pick it. */
  account?: string
  /** Store the credential in a 0600 file when there is no keychain. */
  insecureFile?: boolean
  noBrowser?: boolean
  cliVersion: string
  log?: (message: string) => void
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Tests stand in for the keychain, the index and the browser. */
  store?: SecretStore | null
  index?: LoginIndex
  openUrl?: (url: string) => void
  interactive?: boolean
}

export interface LoginResult {
  apiRoot: string
  user: { id: string; email: string | null }
  account: { id: string; name: string | null; slug: string | null }
  expiresAt: string
  storage: 'keychain' | 'file'
}

function openInBrowser(url: string): void {
  const command = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // The URL is printed; opening it is a convenience.
  }
}

/**
 * `marcapony login`: the device flow. Prints a short code and a URL, opens
 * the browser, and waits while the person approves in the dashboard. The
 * credential goes to the keychain and is never printed.
 */
export async function runLogin(options: LoginOptions): Promise<LoginResult> {
  const log = options.log ?? console.log
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const apiRoot = resolveApiRoot(options.cliEnv)

  // Decide where the credential goes before asking anyone to approve.
  const store =
    options.store !== undefined
      ? options.store
      : options.insecureFile
        ? fileStore(configDir())
        : await keychainStore()
  if (!store) {
    throw new CliError(
      [
        'No keychain is available on this machine, so the login has nowhere safe to go.',
        'In CI or a container, set MARCAPONY_API_KEY to a key from `marcapony app link --ci` instead.',
        'To store it in a file only you can read, run `marcapony login --insecure-file`.',
      ].join('\n'),
      { exitCode: EXIT.failed },
    )
  }

  const code = await requestDeviceCode(
    apiRoot,
    {
      clientName: 'marcapony CLI',
      hostname: hostname().slice(0, 128) || undefined,
      os: `${platform()} ${arch()}`,
      cliVersion: options.cliVersion,
    },
    fetchImpl,
  )
  log(`Your code: ${code.userCode}`)
  log(`Approve it at ${code.verificationUri}`)
  if (options.account) log(`Pick the business ${options.account} on that page.`)
  if (!options.noBrowser && options.interactive !== false) {
    ;(options.openUrl ?? openInBrowser)(code.verificationUriComplete)
  }

  let interval = Math.max(code.interval, 1) * 1000
  const deadline = Date.now() + code.expiresIn * 1000
  while (Date.now() < deadline) {
    await sleep(interval)
    const result = await pollDeviceToken(apiRoot, code.deviceCode, fetchImpl)
    if (result.status === 'pending') continue
    if (result.status === 'slow_down') {
      interval += 5000
      continue
    }
    if (result.status === 'denied') {
      throw new CliError('The login was refused in the dashboard.', { exitCode: EXIT.refused })
    }
    if (result.status === 'expired') break

    const { grant } = result
    const record: LoginRecord = {
      apiRoot,
      accountId: grant.account.id,
      accountSlug: grant.account.slug,
      accountName: grant.account.name,
      userEmail: grant.user.email,
      credentialId: grant.credentialId,
      expiresAt: grant.expiresAt,
      storage: store.kind,
    }
    await store.set(secretKey(record), grant.credential)
    ;(options.index ?? new LoginIndex()).save(record)
    const name = grant.account.name ?? grant.account.slug ?? grant.account.id
    log(`Logged in as ${grant.user.email ?? grant.user.id} to ${name}.`)
    if (options.account && options.account !== grant.account.slug) {
      log(`Note: you approved ${name}, not ${options.account}.`)
    }
    if (store.kind === 'file')
      log(`The credential is in ${configDir()}/credentials.json (mode 0600).`)
    return {
      apiRoot,
      user: grant.user,
      account: grant.account,
      expiresAt: grant.expiresAt,
      storage: store.kind,
    }
  }
  throw new CliError('The code expired before it was approved. Run `marcapony login` again.', {
    exitCode: EXIT.failed,
  })
}

export interface LogoutOptions {
  cliEnv?: string
  cwd: string
  account?: string
  log?: (message: string) => void
  fetchImpl?: typeof fetch
  index?: LoginIndex
  store?: (record: LoginRecord) => Promise<SecretStore | null>
}

/**
 * `marcapony logout`: revokes the login on the platform and deletes it from
 * the keychain. The login of the linked project's business, else the one
 * named with --account, else the only one.
 */
export async function runLogout(options: LogoutOptions): Promise<{ account: string }> {
  const log = options.log ?? console.log
  const apiRoot = resolveApiRoot(options.cliEnv)
  const index = options.index ?? new LoginIndex()
  const project = options.account ? null : readProjectLink(options.cwd)
  const login = await pickLogin(apiRoot, {
    account: options.account,
    project: project?.apiRoot === apiRoot ? project : null,
    index,
    store: options.store,
  }).catch(async (err) => {
    // A record whose secret is already gone can still be forgotten.
    const records = index.forApi(apiRoot)
    if (records.length === 1 && !options.account) {
      index.remove(records[0]!)
      return null
    }
    throw err
  })
  if (!login) {
    log('Logged out.')
    return { account: 'unknown' }
  }
  try {
    await revokeCurrentLogin(apiRoot, login.credential, options.fetchImpl)
  } catch (err) {
    // Already revoked or expired: removing it locally is all that is left.
    if (!(err instanceof CliError && err.code === 'login_required')) throw err
  }
  const store = await (options.store ?? ((r: LoginRecord) => storeFor(r.storage)))(login.record)
  await store?.delete(secretKey(login.record))
  index.remove(login.record)
  const name = login.record.accountName ?? login.record.accountSlug ?? login.record.accountId
  log(`Logged out of ${name}.`)
  return { account: login.record.accountSlug ?? login.record.accountId }
}

export interface LoginStatus {
  logins: Array<{
    api: string
    account: string
    accountId: string
    user: string | null
    expiresAt: string
    storage: 'keychain' | 'file'
    available: boolean
  }>
  project: string
}

/** `marcapony login status`: every login on this machine and what this folder deploys with. */
export async function runLoginStatus(options: {
  cliEnv?: string
  cwd: string
  env: NodeJS.ProcessEnv
  log?: (message: string) => void
  index?: LoginIndex
  store?: (record: LoginRecord) => Promise<SecretStore | null>
}): Promise<LoginStatus> {
  const log = options.log ?? console.log
  const apiRoot = resolveApiRoot(options.cliEnv)
  const index = options.index ?? new LoginIndex()
  const logins: LoginStatus['logins'] = []
  for (const record of index.all()) {
    const loaded = await loadLogin(record.apiRoot, record.accountId, {
      index,
      store: options.store,
    })
    logins.push({
      api: record.apiRoot,
      account: record.accountName ?? record.accountSlug ?? record.accountId,
      accountId: record.accountId,
      user: record.userEmail,
      expiresAt: record.expiresAt,
      storage: record.storage,
      available: loaded !== null,
    })
  }
  if (logins.length === 0) log('Not logged in. Run `marcapony login`.')
  for (const login of logins) {
    const where = login.storage === 'file' ? 'insecure file' : 'keychain'
    log(
      `${login.account} (${new URL(login.api).host}) as ${login.user ?? 'unknown'}, until ${login.expiresAt.slice(0, 10)} if unused, in the ${where}${login.available ? '' : ', missing from storage: log in again'}`,
    )
  }
  const project = describeProjectCredential(options.cwd, options.env, apiRoot)
  log(`This folder deploys with ${project}.`)
  return { logins, project }
}

export { loginRequired }
