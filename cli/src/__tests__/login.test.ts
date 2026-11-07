import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError, EXIT } from '../api'
import { clearSessionCache, resolveDeployKey } from '../credentials'
import { runLink } from '../link'
import { runLogin, runLogout } from '../login'
import {
  LoginIndex,
  keychainStore,
  secretKey,
  type LoginRecord,
  type SecretStore,
} from '../login-store'
import { readProjectLink, writeProjectLink } from '../project-link'
import { runRelease, runReleaseList } from '../release'

// `marcapony login`: the device flow, where the credential lives, which key a
// command deploys with, linking through the login, and releases.

const API = 'https://staging-api.marcapony.com'
const ACCOUNT = { id: 'acc-1', name: 'ABC Corp', slug: 'abc' }
const APP_ID = '11111111-1111-4111-8111-111111111111'
const CREDENTIAL = `mpu_${'c'.repeat(43)}`

let dir: string
let configDir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'marcapony-login-'))
  configDir = mkdtempSync(join(tmpdir(), 'marcapony-config-'))
  clearSessionCache()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Call = { url: string; init: RequestInit }
function routeFetch(routes: Array<[string, (init: RequestInit) => Response]>): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init: init ?? {} })
    const route =
      routes.find(([suffix]) => u.endsWith(suffix)) ?? routes.find(([suffix]) => u.includes(suffix))
    if (!route) throw new Error(`unexpected request ${u}`)
    return route[1](init ?? {})
  }) as typeof fetch
  return { fetch: impl, calls }
}

function memoryStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    kind: 'keychain',
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  }
}

const record = (over: Partial<LoginRecord> = {}): LoginRecord => ({
  apiRoot: API,
  accountId: ACCOUNT.id,
  accountSlug: ACCOUNT.slug,
  accountName: ACCOUNT.name,
  userEmail: 'dev@example.com',
  credentialId: 'cred-1',
  expiresAt: '2027-02-05T00:00:00.000Z',
  storage: 'keychain',
  ...over,
})

function loggedIn(): { index: LoginIndex; store: ReturnType<typeof memoryStore> } {
  const index = new LoginIndex(configDir)
  const store = memoryStore()
  index.save(record())
  void store.set(secretKey(record()), CREDENTIAL)
  return { index, store }
}

const authOf = (call: Call) => (call.init.headers as Record<string, string>).Authorization

describe('marcapony login', () => {
  it('waits for the approval, then keeps the credential in the keychain only', async () => {
    const store = memoryStore()
    const index = new LoginIndex(configDir)
    const polls = [
      json({ error: { code: 'authorization_pending', message: 'wait' } }, 400),
      json({ error: { code: 'slow_down', message: 'slower' } }, 400),
      json({
        credential: CREDENTIAL,
        credentialId: 'cred-1',
        expiresAt: '2027-02-05T00:00:00.000Z',
        user: { id: 'user-1', email: 'dev@example.com' },
        account: ACCOUNT,
      }),
    ]
    const sleeps: number[] = []
    const opened: string[] = []
    const logs: string[] = []
    const { fetch, calls } = routeFetch([
      [
        '/cli/device-codes',
        () =>
          json(
            {
              deviceCode: 'mpd_x',
              userCode: 'BCDF-GHJK',
              verificationUri: 'https://staging-app.marcapony.com/cli/activate',
              verificationUriComplete:
                'https://staging-app.marcapony.com/cli/activate?code=BCDF-GHJK',
              interval: 5,
              expiresIn: 600,
            },
            201,
          ),
      ],
      ['/cli/device-tokens', () => polls.shift()!],
    ])
    const result = await runLogin({
      cliEnv: 'staging',
      cliVersion: '0.11.0',
      fetchImpl: fetch,
      store,
      index,
      sleep: async (ms) => void sleeps.push(ms),
      openUrl: (url) => void opened.push(url),
      log: (m) => logs.push(m),
    })
    expect(result.account.slug).toBe('abc')
    expect(sleeps).toEqual([5000, 5000, 10000])
    expect(opened).toEqual(['https://staging-app.marcapony.com/cli/activate?code=BCDF-GHJK'])
    expect(store.data.get(`staging-api.marcapony.com:acc-1`)).toBe(CREDENTIAL)
    expect(index.find(API, 'acc-1')).toMatchObject({ credentialId: 'cred-1', storage: 'keychain' })
    expect(readFileSync(join(configDir, 'logins.json'), 'utf8')).not.toContain(CREDENTIAL)
    expect(logs.join('\n')).not.toContain(CREDENTIAL)
    expect(logs.join('\n')).toContain('BCDF-GHJK')
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      clientName: 'marcapony CLI',
      cliVersion: '0.11.0',
    })
  })

  it('refuses before asking for approval when there is no keychain', async () => {
    const { fetch, calls } = routeFetch([])
    const err = await runLogin({ cliVersion: '0.11.0', fetchImpl: fetch, store: null }).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(CliError)
    expect((err as Error).message).toContain('--insecure-file')
    expect(calls).toHaveLength(0)
  })

  it('exits 4 when the login is refused in the dashboard', async () => {
    const { fetch } = routeFetch([
      [
        '/cli/device-codes',
        () =>
          json({
            deviceCode: 'd',
            userCode: 'BCDF-GHJK',
            verificationUri: 'u',
            verificationUriComplete: 'u',
            interval: 1,
            expiresIn: 60,
          }),
      ],
      ['/cli/device-tokens', () => json({ error: { code: 'access_denied', message: 'no' } }, 400)],
    ])
    const err = (await runLogin({
      cliVersion: '0.11.0',
      fetchImpl: fetch,
      store: memoryStore(),
      index: new LoginIndex(configDir),
      sleep: async () => undefined,
      interactive: false,
      log: () => undefined,
    }).catch((e) => e)) as CliError
    expect(err.exitCode).toBe(EXIT.refused)
  })

  it('logout revokes the login on the platform and forgets it', async () => {
    const { index, store } = loggedIn()
    const { fetch, calls } = routeFetch([
      ['/ext/v1/cli/credentials/current', () => json({ data: { revoked: true } })],
    ])
    await runLogout({
      cwd: dir,
      cliEnv: 'staging',
      fetchImpl: fetch,
      index,
      store: async () => store,
      log: () => undefined,
    })
    expect(calls[0]!.init.method).toBe('DELETE')
    expect(authOf(calls[0]!)).toBe(`Bearer ${CREDENTIAL}`)
    expect(store.data.size).toBe(0)
    expect(index.all()).toEqual([])
  })
})

describe('keychainStore', () => {
  it('is null without the native module', async () => {
    expect(
      await keychainStore(async () => {
        throw new Error('Cannot find module')
      }),
    ).toBeNull()
  })

  it('is null when the system has no secret service', async () => {
    const mod = {
      Entry: class {
        getPassword() {
          throw new Error('Platform secure storage failure: no secret service')
        }
      },
    }
    expect(await keychainStore(async () => mod)).toBeNull()
  })

  it('works when the probe finds no entry', async () => {
    const saved = new Map<string, string>()
    const mod = {
      Entry: class {
        constructor(
          _s: string,
          private readonly key: string,
        ) {}
        getPassword() {
          return saved.get(this.key) ?? null
        }
        setPassword(p: string) {
          saved.set(this.key, p)
        }
        deletePassword() {
          saved.delete(this.key)
        }
      },
    }
    const store = await keychainStore(async () => mod)
    expect(store?.kind).toBe('keychain')
    await store!.set('k', 'v')
    expect(await store!.get('k')).toBe('v')
  })
})

describe('which key a command deploys with', () => {
  const session = () =>
    json(
      {
        data: {
          key: 'mpk_session',
          keyId: 'k',
          expiresAt: null,
          appId: APP_ID,
          appSlug: 'kaynak',
          environmentId: 'e',
          environmentName: 'test',
          baseUrl: `${API}/ext/v1`,
        },
      },
      201,
    )

  it('MARCAPONY_API_KEY from the environment wins', async () => {
    const key = await resolveDeployKey({
      cwd: dir,
      env: { MARCAPONY_API_KEY: 'mpk_ci' },
      apiRoot: API,
    })
    expect(key).toBe('mpk_ci')
  })

  it('a login-linked project exchanges the login for a session key, once per run', async () => {
    const { index, store } = loggedIn()
    writeProjectLink(dir, {
      apiRoot: API,
      accountId: 'acc-1',
      accountSlug: 'abc',
      appId: APP_ID,
      appSlug: 'kaynak',
      environment: 'test',
    })
    writeFileSync(join(dir, '.env.local'), 'MARCAPONY_API_KEY=mpk_devkey\n')
    const { fetch, calls } = routeFetch([['/ext/v1/cli/sessions', session]])
    const deps = { index, store: async () => store, fetchImpl: fetch }
    expect(await resolveDeployKey({ cwd: dir, env: {}, apiRoot: API, ...deps })).toBe('mpk_session')
    expect(await resolveDeployKey({ cwd: dir, env: {}, apiRoot: API, ...deps })).toBe('mpk_session')
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ appId: APP_ID, environment: 'test' })
  })

  it('exits 7 when the project needs a login that is gone', async () => {
    writeProjectLink(dir, {
      apiRoot: API,
      accountId: 'acc-1',
      accountSlug: 'abc',
      appId: APP_ID,
      appSlug: 'kaynak',
      environment: 'test',
    })
    const err = (await resolveDeployKey({
      cwd: dir,
      env: {},
      apiRoot: API,
      index: new LoginIndex(configDir),
    }).catch((e) => e)) as CliError
    expect(err.exitCode).toBe(EXIT.loginRequired)
  })

  it('exits 7 when the platform no longer accepts the login', async () => {
    const { index, store } = loggedIn()
    writeProjectLink(dir, {
      apiRoot: API,
      accountId: 'acc-1',
      accountSlug: 'abc',
      appId: APP_ID,
      appSlug: 'kaynak',
      environment: 'test',
    })
    const { fetch } = routeFetch([
      [
        '/ext/v1/cli/sessions',
        () => json({ error: { code: 'login_required', message: 'Run marcapony login' } }, 401),
      ],
    ])
    const err = (await resolveDeployKey({
      cwd: dir,
      env: {},
      apiRoot: API,
      index,
      store: async () => store,
      fetchImpl: fetch,
    }).catch((e) => e)) as CliError
    expect(err.exitCode).toBe(EXIT.loginRequired)
  })

  it('a folder linked with a pairing code keeps its deploy key', async () => {
    writeFileSync(join(dir, '.env.local'), 'MARCAPONY_API_KEY=mpk_folder\n')
    expect(
      await resolveDeployKey({ cwd: dir, env: {}, apiRoot: API, index: new LoginIndex(configDir) }),
    ).toBe('mpk_folder')
  })
})

const APPS = {
  data: {
    apps: [
      {
        id: APP_ID,
        name: 'Kaynak',
        slug: 'kaynak',
        environments: [
          { id: 'env-prod', name: 'production', liveDeploymentId: 'dep-p', liveVersion: 3 },
          { id: 'env-test', name: 'test', liveDeploymentId: 'dep-t', liveVersion: 7 },
        ],
      },
    ],
  },
}

describe('marcapony app link with a login', () => {
  const devKey = () =>
    json(
      {
        data: {
          key: 'mpk_devkey',
          keyId: 'k-dev',
          expiresAt: null,
          appId: APP_ID,
          appSlug: 'kaynak',
          environmentId: 'env-test',
          environmentName: 'test',
          baseUrl: `${API}/ext/v1`,
        },
      },
      201,
    )

  it('needs no pairing code and keeps only a data-only key in the folder', async () => {
    const { index, store } = loggedIn()
    const { fetch, calls } = routeFetch([
      ['/ext/v1/cli/apps', () => json(APPS)],
      ['/ext/v1/cli/dev-keys', devKey],
      ['/ext/v1/capabilities', () => json({ data: [] })],
    ])
    await runLink({
      cwd: dir,
      cliEnv: 'staging',
      env: {},
      app: 'kaynak',
      envName: 'test',
      fetchImpl: fetch,
      log: () => undefined,
      credentialDeps: { index, store: async () => store },
    })
    expect(readProjectLink(dir)).toEqual({
      apiRoot: API,
      accountId: 'acc-1',
      accountSlug: 'abc',
      appId: APP_ID,
      appSlug: 'kaynak',
      environment: 'test',
    })
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toContain('MARCAPONY_API_KEY=mpk_devkey')
    expect(JSON.parse(readFileSync(join(dir, 'marcapony.json'), 'utf8')).app).toBe('kaynak')
    expect(calls.some((c) => c.url.endsWith('/apps/link'))).toBe(false)
  })

  it('--refresh moves a pairing-code folder over and revokes its old deploy key', async () => {
    const { index, store } = loggedIn()
    writeFileSync(
      join(dir, 'marcapony.json'),
      JSON.stringify({ manifest: 2, app: 'kaynak', build: 'bun run build' }),
    )
    writeFileSync(join(dir, '.env.local'), 'MARCAPONY_API_KEY=mpk_oldkey\n')
    const { fetch, calls } = routeFetch([
      ['/ext/v1/cli/apps', () => json(APPS)],
      [
        '/ext/v1/deployments/source-head',
        () =>
          json({
            data: {
              enabled: true,
              environmentId: 'env-test',
              branch: 'test',
              head: null,
              stale: false,
              scan: null,
              movedBy: null,
              rewrites: {},
            },
          }),
      ],
      ['/ext/v1/cli/dev-keys', devKey],
      ['/ext/v1/cli/keys/revoke', () => json({ data: { revoked: true } })],
      ['/ext/v1/capabilities', () => json({ data: [] })],
    ])
    await runLink({
      cwd: dir,
      cliEnv: 'staging',
      env: {},
      refresh: true,
      fetchImpl: fetch,
      log: () => undefined,
      credentialDeps: { index, store: async () => store },
    })
    const revoke = calls.find((c) => c.url.endsWith('/ext/v1/cli/keys/revoke'))!
    expect(JSON.parse(String(revoke.init.body))).toEqual({ key: 'mpk_oldkey' })
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toContain('mpk_devkey')
    expect(readProjectLink(dir)?.environment).toBe('test')
  })
})

describe('marcapony app release', () => {
  function linkedRelease() {
    const deps = loggedIn()
    writeProjectLink(dir, {
      apiRoot: API,
      accountId: 'acc-1',
      accountSlug: 'abc',
      appId: APP_ID,
      appSlug: 'kaynak',
      environment: 'test',
    })
    return deps
  }
  const preview = (over: Record<string, unknown> = {}) =>
    json({
      deploymentId: 'dep-t',
      version: 7,
      sourceEnvironmentName: 'test',
      commitCount: 2,
      olderThanPreviousRelease: false,
      productionMoved: false,
      productionCommits: [],
      missingValues: [],
      blockers: [],
      warnings: [],
      commitAvailable: true,
      ...over,
    })

  it('promotes the test version with the login and waits until live', async () => {
    const { index, store } = linkedRelease()
    const statuses = ['deploying', 'live']
    const { fetch, calls } = routeFetch([
      ['/ext/v1/cli/apps', () => json(APPS)],
      [
        '/releases/preview?deploymentId=dep-t',
        () => preview({ warnings: ['bundle_hash_mismatch'] }),
      ],
      [
        '/releases/rel-1',
        () =>
          json({
            id: 'rel-1',
            number: 4,
            status: statuses.shift(),
            kind: 'promote',
            title: 't',
            failureStep: null,
            error: null,
            createdAt: '2026-11-07T00:00:00Z',
            liveAt: null,
            commitCount: 2,
            label: null,
          }),
      ],
      [
        `/apps/${APP_ID}/releases`,
        () =>
          json(
            {
              id: 'rel-1',
              number: 4,
              status: 'committing',
              kind: 'promote',
              title: 't',
              failureStep: null,
              error: null,
              createdAt: '2026-11-07T00:00:00Z',
              liveAt: null,
              commitCount: 2,
              label: null,
            },
            201,
          ),
      ],
    ])
    const result = await runRelease({
      cwd: dir,
      cliEnv: 'staging',
      yes: true,
      fetchImpl: fetch,
      sleep: async () => undefined,
      log: () => undefined,
      credentialDeps: { index, store: async () => store },
    })
    expect(result.release.status).toBe('live')
    const create = calls.find((c) => c.init.method === 'POST')!
    expect(JSON.parse(String(create.init.body))).toEqual({
      kind: 'promote',
      deploymentId: 'dep-t',
      title: 'test v7',
      acknowledgeWarnings: true,
    })
    expect(calls.every((c) => authOf(c) === `Bearer ${CREDENTIAL}`)).toBe(true)
  })

  it('exits 4 with the blockers and promotes nothing', async () => {
    const { index, store } = linkedRelease()
    const logs: string[] = []
    const { fetch, calls } = routeFetch([
      ['/releases/preview', () => preview({ blockers: ['source_pending'] })],
      ['/ext/v1/cli/apps', () => json(APPS)],
    ])
    const err = (await runRelease({
      cwd: dir,
      cliEnv: 'staging',
      yes: true,
      fetchImpl: fetch,
      log: (m) => logs.push(m),
      credentialDeps: { index, store: async () => store },
    }).catch((e) => e)) as CliError
    expect(err.exitCode).toBe(EXIT.refused)
    expect(logs.join('\n')).toContain('secret scan has not finished')
    expect(calls.some((c) => c.init.method === 'POST')).toBe(false)
  })

  it('needs a login-linked folder: an app key is never enough', async () => {
    writeFileSync(join(dir, '.env.local'), 'MARCAPONY_API_KEY=mpk_prodkey\n')
    const err = (await runReleaseList({
      cwd: dir,
      cliEnv: 'staging',
      credentialDeps: { index: new LoginIndex(configDir) },
    }).catch((e) => e)) as CliError
    expect(err.exitCode).toBe(EXIT.loginRequired)
  })

  it('without a prompt and without --yes it refuses instead of waiting', async () => {
    const { index, store } = linkedRelease()
    const { fetch } = routeFetch([
      ['/releases/preview', () => preview()],
      ['/ext/v1/cli/apps', () => json(APPS)],
    ])
    const err = (await runRelease({
      cwd: dir,
      cliEnv: 'staging',
      fetchImpl: fetch,
      log: () => undefined,
      credentialDeps: { index, store: async () => store },
    }).catch((e) => e)) as CliError
    expect(err.message).toContain('--yes')
    expect(existsSync(join(dir, '.env.local'))).toBe(false)
  })
})
