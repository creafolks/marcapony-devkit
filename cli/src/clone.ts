import * as fs from 'node:fs'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { CliError, EXIT, exchangeCode, fetchSourceHead, fetchSourceReadGrant } from './api.js'
import { readConfig, resolveApiRoot } from './config.js'
import { retireEarlierKeys, writeAgentsBestEffort, writeLinkedKey } from './link.js'
import { writeBase } from './lock.js'
import { tokenSecret } from './source.js'

export interface CloneOptions {
  /** Where the clone goes: a new or empty directory. */
  dir?: string
  /** The directory `dir` is resolved against. */
  cwd: string
  code?: string
  /** Hidden team override: local | staging | production (defaults to production). */
  cliEnv?: string
  fetchImpl?: typeof fetch
  /** Injected in tests; defaults to isomorphic-git's clone. */
  clone?: typeof git.clone
  log?: (message: string) => void
}

export interface CloneResult {
  dir: string
  branch: string
  head: string
  environmentName: string
}

function isEmptyDir(path: string): boolean {
  return !existsSync(path) || readdirSync(path).length === 0
}

/**
 * `marcapony app clone <dir> --code <code>`: exchange a pairing code for the
 * environment's key, clone its branch with a short-lived read token, and link
 * the clone, so it can be edited and deployed at once. The token is handed to
 * git through its auth callback only: never printed, never written to the
 * remote URL, `.git/config` or any file. The cloned commit is the project's
 * base in `marcapony.lock`.
 */
export async function runClone(options: CloneOptions): Promise<CloneResult> {
  const log = options.log ?? console.log
  const code = options.code?.trim()
  if (!options.dir || !code) {
    throw new CliError('Usage: marcapony app clone <dir> --code <code>', { exitCode: EXIT.failed })
  }
  const apiRoot = resolveApiRoot(options.cliEnv)
  const fetchImpl = options.fetchImpl ?? fetch

  // Checked before the pairing code is used: a code is spent once.
  const name = options.dir
  const dir = isAbsolute(name) ? name : resolve(options.cwd, name)
  if (!isEmptyDir(dir)) {
    throw new CliError(`${name} already exists and is not empty.`, { exitCode: EXIT.failed })
  }

  const link = await exchangeCode(apiRoot, code, fetchImpl)
  // Past this point the key exists; a failure says so, since nothing saved it.
  const unusedKey = ` The key made for ${link.environmentName} was not saved${
    link.expiresAt ? ` (it expires on ${link.expiresAt.slice(0, 10)})` : ''
  }; revoke it from the app page.`
  const head = await fetchSourceHead(apiRoot, link.key, fetchImpl)
  if (!head?.enabled || !head.environmentId || !head.head) {
    throw new CliError(
      `${link.environmentName} has no saved source yet. Deploy it once with the CLI, then clone.${unusedKey}`,
      { exitCode: EXIT.refused },
    )
  }
  if (head.scan === 'blocked') {
    throw new CliError(
      `The latest version of ${link.environmentName} is blocked by the platform's scan, so it is not cloned. Deploy a version without the finding, then clone.${unusedKey}`,
      { code: 'source_blocked', exitCode: EXIT.refused },
    )
  }
  if (head.scan === 'pending') {
    log(`Warning: the latest version of ${link.environmentName} is still being scanned.`)
  }
  // Minted only once the clone will go ahead: each token is recorded and rate-limited.
  let grant: Awaited<ReturnType<typeof fetchSourceReadGrant>>
  try {
    grant = await fetchSourceReadGrant(apiRoot, link.key, fetchImpl)
  } catch (err) {
    if (err instanceof CliError) {
      throw new CliError(`${err.message}.${unusedKey}`, {
        code: err.code,
        status: err.status,
        exitCode: err.exitCode,
      })
    }
    throw err
  }
  if (!grant) {
    throw new CliError(
      `${link.environmentName} has no saved source yet. Deploy it once with the CLI, then clone.${unusedKey}`,
      { exitCode: EXIT.refused },
    )
  }

  const created = !existsSync(dir)
  mkdirSync(dir, { recursive: true })
  try {
    await (options.clone ?? git.clone)({
      fs,
      http,
      dir,
      url: grant.remote,
      ref: grant.branch,
      singleBranch: true,
      onAuth: () => ({ username: 'x', password: tokenSecret(grant.token) }),
    })
  } catch (err) {
    // Leave the directory as it was: gone if this made it, empty if it was.
    if (created) rmSync(dir, { recursive: true, force: true })
    else
      for (const entry of readdirSync(dir))
        rmSync(join(dir, entry), { recursive: true, force: true })
    // The message never carries the token: isomorphic-git reports the URL, which holds none.
    throw new CliError(
      `Clone failed: ${err instanceof Error ? err.message : String(err)}.${unusedKey}`,
      { exitCode: EXIT.failed },
    )
  }

  // The cloned commit is the base for these files, whatever the head is now.
  const cloned = await git.resolveRef({ fs, dir, ref: 'HEAD' })
  writeBase(dir, head.environmentId, cloned)
  if (cloned !== head.head) {
    log(
      `Warning: ${link.environmentName} moved during the clone. Run \`marcapony app pull\` before you deploy.`,
    )
  }

  const config = readConfig(dir)
  const { envFile, newlyIgnored } = writeLinkedKey(dir, config, link)
  log(`Cloned ${link.appSlug ?? 'the app'} (${link.environmentName}) into ${name}.`)
  log(`  Branch         ${grant.branch} at ${cloned.slice(0, 7)}`)
  log(`  ${envFile.padEnd(14)} MARCAPONY_API_KEY, MARCAPONY_API_URL written`)
  if (link.expiresAt) log(`  Key expires    ${link.expiresAt.slice(0, 10)}; link again to renew it`)
  await retireEarlierKeys(apiRoot, link.key, fetchImpl, log)
  if (newlyIgnored) log(`  .gitignore     ${envFile} added; it holds a live key, never commit it`)
  if (config) {
    await writeAgentsBestEffort(dir, config.app, link.key, envFile, apiRoot, fetchImpl, log)
  } else {
    log('  marcapony.json not found in the saved source; run `marcapony app link` to create one')
  }
  log(`Next: cd ${name}, install the dependencies, edit, then marcapony app deploy`)
  return { dir, branch: grant.branch, head: cloned, environmentName: link.environmentName }
}
