import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXIT } from '../api'
import { main } from '../index'
import {
  apiRootOfGitHost,
  appIdOfPath,
  branchOfEnvironment,
  parseCredentialRequest,
  runGitCredential,
  runRemoteAdd,
  runRemoteRemove,
} from '../git-remote'
import { LoginIndex, secretKey, type LoginRecord, type SecretStore } from '../login-store'
import { writeProjectLink } from '../project-link'

// `marcapony app remote add|remove` and `marcapony git-credential`: plain git
// against the platform, with the CLI as git's credential helper.

const API = 'https://staging-api.marcapony.com'
const HOST = 'staging-git.marcapony.com'
const APP_ID = '11111111-1111-4111-8111-111111111111'
const LOGIN = `mpu_${'c'.repeat(43)}`
const KEY = `mpk_${'k'.repeat(40)}`
const SESSION = {
  username: 'marcapony',
  password: `mps_${'s'.repeat(43)}`,
  expiresAt: '2026-11-07T12:15:00.000Z',
  remote: `https://${HOST}/${APP_ID}.git`,
  environmentId: null,
}
const HELPER = '!marcapony git-credential'

let dir: string
let configDir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'marcapony-remote-'))
  configDir = mkdtempSync(join(tmpdir(), 'marcapony-config-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
})

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  return (result.stdout ?? '').trim()
}

/** The helper list as git keeps it, the empty reset entry included. */
function helpers(): string[] {
  const result = spawnSync(
    'git',
    ['config', '--local', '--get-all', `credential.https://${HOST}.helper`],
    { cwd: dir, encoding: 'utf8' },
  )
  return (result.stdout ?? '').replace(/\n$/, '').split('\n')
}

function sessionFetch(status = 201, body: unknown = { data: SESSION }) {
  const calls: Array<{ url: string; auth: string | null; body: unknown }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: String(url),
      auth: headers.get('Authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    if (String(url).endsWith('/ext/v1/deployments/source-head')) {
      return Response.json({
        data: {
          enabled: true,
          branch: 'test',
          head: null,
          stale: false,
          scan: null,
          movedBy: null,
          rewrites: {},
          appId: APP_ID,
          environmentName: 'test',
        },
      })
    }
    return Response.json(body, { status })
  }) as typeof fetch
  return { fetch: impl, calls }
}

function loggedIn(): { index: LoginIndex; store: () => Promise<SecretStore> } {
  const record: LoginRecord = {
    apiRoot: API,
    accountId: 'acc-1',
    accountSlug: 'abc',
    accountName: 'ABC',
    userEmail: 'a@example.com',
    credentialId: 'cred-1',
    expiresAt: '2027-01-01T00:00:00.000Z',
    storage: 'keychain',
  }
  const index = new LoginIndex(configDir)
  index.save(record)
  const data = new Map([[secretKey(record), LOGIN]])
  const store: SecretStore = {
    kind: 'keychain',
    get: async (key) => data.get(key) ?? null,
    set: async () => undefined,
    delete: async () => undefined,
  }
  return { index, store: async () => store }
}

function linkWithLogin(environment = 'test'): void {
  writeProjectLink(dir, {
    apiRoot: API,
    accountId: 'acc-1',
    accountSlug: 'abc',
    appId: APP_ID,
    appSlug: 'qa',
    environment,
  })
}

function linkWithKey(): void {
  writeFileSync(join(dir, 'marcapony.json'), JSON.stringify({ manifest: 2 }))
  writeFileSync(join(dir, '.env.local'), `MARCAPONY_API_KEY=${KEY}\nMARCAPONY_API_URL=${API}\n`)
}

describe('helpers', () => {
  it('reads git credential requests, remote paths and branch names', () => {
    expect(
      parseCredentialRequest(`protocol=https\nhost=${HOST}\npath=${APP_ID}.git\n\nignored=1`),
    ).toEqual({
      protocol: 'https',
      host: HOST,
      path: `${APP_ID}.git`,
    })
    expect(appIdOfPath(`/${APP_ID}.git`)).toBe(APP_ID)
    expect(appIdOfPath(APP_ID.toUpperCase())).toBe(APP_ID)
    expect(appIdOfPath('owner/repo.git')).toBeNull()
    expect(branchOfEnvironment('Test Ayşe')).toBe('test-ay-e')
    expect(branchOfEnvironment('production')).toBe('production')
    expect(apiRootOfGitHost('git.marcapony.com')).toBe('https://api.marcapony.com')
    expect(apiRootOfGitHost('github.com')).toBeNull()
  })
})

describe('marcapony git-credential', () => {
  async function get(
    input: string,
    deps: Parameters<typeof runGitCredential>[0] extends infer T ? Partial<T> : never,
  ) {
    let out = ''
    const warnings: string[] = []
    const code = await runGitCredential({
      action: 'get',
      cwd: dir,
      env: {},
      input,
      write: (text) => {
        out += text
      },
      warn: (m) => warnings.push(m),
      index: new LoginIndex(configDir),
      ...deps,
    })
    return { code, out, warnings }
  }
  const request = `protocol=https\nhost=${HOST}\npath=${APP_ID}.git\n`

  it("prints only the session, made from the folder's deploy key", async () => {
    linkWithKey()
    const { fetch, calls } = sessionFetch()
    const { code, out } = await get(request, { fetchImpl: fetch })
    expect(code).toBe(EXIT.ok)
    expect(out).toBe(
      `username=marcapony\npassword=${SESSION.password}\npassword_expiry_utc=${Date.parse(SESSION.expiresAt) / 1000}\n`,
    )
    expect(calls).toEqual([
      { url: `${API}/ext/v1/git/sessions`, auth: `Bearer ${KEY}`, body: { appId: APP_ID } },
    ])
  })

  it("uses the folder's deploy key before a login to another business", async () => {
    linkWithKey()
    const { index, store } = loggedIn()
    const { fetch, calls } = sessionFetch()
    const { code, out } = await get(request, { fetchImpl: fetch, index, store })
    expect(code).toBe(EXIT.ok)
    expect(out).toContain(`password=${SESSION.password}`)
    expect(calls.map((c) => c.auth)).toEqual([`Bearer ${KEY}`])
  })

  it('uses the login in a folder linked with it, and the folder key when the login does not reach the app', async () => {
    linkWithLogin()
    writeFileSync(join(dir, '.env.local'), `MARCAPONY_API_KEY=${KEY}\n`)
    const { index, store } = loggedIn()
    const calls: string[] = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('Authorization') ?? ''
      calls.push(auth)
      return auth === `Bearer ${LOGIN}`
        ? Response.json(
            { error: { code: 'not_found', message: 'No such app in this account' } },
            { status: 404 },
          )
        : Response.json({ data: SESSION }, { status: 201 })
    }) as typeof fetch
    const { code, out } = await get(request, { fetchImpl, index, store })
    expect(code).toBe(EXIT.ok)
    expect(out).toContain(`password=${SESSION.password}`)
    expect(calls).toEqual([`Bearer ${LOGIN}`, `Bearer ${KEY}`])
  })

  it('stays silent for other hosts and when it has no credential', async () => {
    const { fetch, calls } = sessionFetch()
    const other = await get('protocol=https\nhost=github.com\npath=a/b.git\n', { fetchImpl: fetch })
    expect(other).toEqual({ code: EXIT.ok, out: '', warnings: [] })
    const none = await get(request, { fetchImpl: fetch })
    expect(none.code).toBe(EXIT.ok)
    expect(none.out).toBe('')
    expect(none.warnings[0]).toContain('marcapony login')
    expect(calls).toHaveLength(0)
  })

  it('says why on stderr and exits 7 when the login is gone', async () => {
    const { index, store } = loggedIn()
    const { fetch } = sessionFetch(401, {
      error: { code: 'login_required', message: 'Not logged in. Run `marcapony login`.' },
    })
    const { code, out, warnings } = await get(request, { fetchImpl: fetch, index, store })
    expect(code).toBe(EXIT.loginRequired)
    expect(out).toBe('')
    expect(warnings[0]).toContain('login_required')
  })

  it('does nothing for store and erase', async () => {
    for (const action of ['store', 'erase']) {
      let out = ''
      expect(
        await runGitCredential({
          action,
          cwd: dir,
          env: {},
          input: '',
          write: (t) => {
            out += t
          },
          warn: () => undefined,
        }),
      ).toBe(EXIT.ok)
      expect(out).toBe('')
    }
  })
})

describe('marcapony app remote add / remove', () => {
  beforeEach(() => {
    spawnSync('git', ['init', '-q'], { cwd: dir })
  })
  const add = (extra: Partial<Parameters<typeof runRemoteAdd>[0]> = {}) => {
    const { index, store } = loggedIn()
    const { fetch } = sessionFetch()
    const logs: string[] = []
    return runRemoteAdd({
      cwd: dir,
      cliEnv: 'staging',
      env: {},
      log: (m) => logs.push(m),
      fetchImpl: fetch,
      index,
      store,
      helperCommand: HELPER,
      ...extra,
    }).then((result) => ({ result, logs }))
  }

  it('adds the remote, its push branch and the helper in the repository config only', async () => {
    linkWithLogin()
    const { result, logs } = await add()
    expect(result).toEqual({
      remote: 'marcapony',
      url: SESSION.remote,
      branch: 'test',
      environment: 'test',
      created: true,
    })
    expect(git('remote', 'get-url', 'marcapony')).toBe(SESSION.remote)
    expect(git('config', '--get', 'remote.marcapony.push')).toBe('HEAD:refs/heads/test')
    expect(helpers()).toEqual(['', HELPER])
    expect(git('config', '--local', '--get', `credential.https://${HOST}.useHttpPath`)).toBe('true')
    expect(logs.at(-1)).toBe('Next: git push marcapony')
  })

  it('is idempotent, and --env points the push at another branch', async () => {
    linkWithLogin()
    await add()
    const { result } = await add({ envName: 'Test Ayşe', name: 'marcapony' })
    expect(result.created).toBe(false)
    expect(result.branch).toBe('test-ay-e')
    expect(git('config', '--get-all', 'remote.marcapony.push')).toBe('HEAD:refs/heads/test-ay-e')
    expect(helpers()).toEqual(['', HELPER])
  })

  it("keeps a deploy key's folder to its own environment", async () => {
    linkWithKey()
    const { fetch } = sessionFetch()
    const base = {
      cwd: dir,
      cliEnv: 'staging',
      env: {},
      log: () => undefined,
      fetchImpl: fetch,
      index: new LoginIndex(configDir),
      helperCommand: HELPER,
    }
    expect((await runRemoteAdd(base)).branch).toBe('test')
    await expect(runRemoteAdd({ ...base, envName: 'production' })).rejects.toMatchObject({
      exitCode: EXIT.refused,
    })
  })

  it('refuses an unlinked folder with exit 5 and a folder that is not a git repository', async () => {
    await expect(add()).rejects.toMatchObject({ exitCode: EXIT.notLinked })
    rmSync(join(dir, '.git'), { recursive: true, force: true })
    linkWithLogin()
    await expect(add()).rejects.toMatchObject({ exitCode: EXIT.failed })
  })

  it('notes that a release-only production takes no push', async () => {
    linkWithLogin('production')
    const { logs } = await add()
    expect(logs[0]).toContain('releases')
  })

  it('removes the remote and its helper lines', async () => {
    linkWithLogin()
    await add()
    const removed = await runRemoteRemove({ cwd: dir, log: () => undefined })
    expect(removed).toEqual({ remote: 'marcapony', removed: true })
    expect(git('remote')).toBe('')
    expect(git('config', '--local', '--get-all', `credential.https://${HOST}.helper`)).toBe('')
    expect((await runRemoteRemove({ cwd: dir, log: () => undefined })).removed).toBe(false)
  })
})

describe('marcapony git-credential through main', () => {
  it('answers before anything else: no update check, nothing on stdout or stderr', async () => {
    const realFetch = globalThis.fetch
    const realLog = console.log
    const realError = console.error
    const fetched: string[] = []
    const printed: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      fetched.push(String(url))
      return new Response('{}')
    }) as typeof fetch
    console.log = (...args: unknown[]) => void printed.push(args.join(' '))
    console.error = (...args: unknown[]) => void printed.push(args.join(' '))
    let out = ''
    const warnings: string[] = []
    try {
      const code = await main(['git-credential', 'get'], {
        readInput: async () => 'protocol=https\nhost=github.com\npath=a/b.git\n',
        write: (text) => {
          out += text
        },
        warn: (m) => warnings.push(m),
      })
      expect(code).toBe(EXIT.ok)
    } finally {
      globalThis.fetch = realFetch
      console.log = realLog
      console.error = realError
    }
    expect(out).toBe('')
    expect(warnings).toEqual([])
    expect(printed).toEqual([])
    expect(fetched).toEqual([])
  })
})
