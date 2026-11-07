import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLI_VERSION, projectSdkVersion, userAgent, withCliHeaders } from '../client-info'
import { createDeployment } from '../api'
import { runDeployDetailed } from '../deploy'
import {
  UPDATE_CHECK_INTERVAL_MS,
  isBehind,
  latestCliVersion,
  startUpdateCheck,
  updateCheckEnabled,
  updateLine,
} from '../update-check'

// The CLI says who it is, sends the project's SDK version on deploy, and
// checks npm for a newer CLI on its own once a day.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'marcapony-update-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('client headers', () => {
  it('match the published version', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')) as {
      version: string
    }
    expect(CLI_VERSION).toBe(pkg.version)
  })

  it('adds the User-Agent and the version header, keeping the caller’s headers', async () => {
    let seen: Headers | null = null
    const wrapped = withCliHeaders((async (_url: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers)
      return json({})
    }) as typeof fetch)
    await wrapped('http://x/y', { headers: { Authorization: 'Bearer k' } })
    expect(seen!.get('X-Marcapony-Cli')).toBe(CLI_VERSION)
    expect(seen!.get('User-Agent')).toBe(userAgent())
    expect(seen!.get('Authorization')).toBe('Bearer k')
    expect(userAgent()).toMatch(/^marcapony-cli\/\d+\.\d+\.\d+ \((bun|node)\/[^;]+; [a-z0-9]+\)$/)
  })

  it('sends the SDK version on deploy only when given', async () => {
    const seen: Headers[] = []
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      return json({ data: { id: 'd', status: 'live', hostname: null, error: null } }, 201)
    }) as typeof fetch
    const payload = { worker: { main: 'index.js', content: '', encoding: 'base64' as const } }
    await createDeployment('http://x', 'k', payload, fetchImpl, undefined, { sdkVersion: '0.7.1' })
    await createDeployment('http://x', 'k', payload, fetchImpl)
    expect(seen[0]!.get('X-Marcapony-Sdk')).toBe('0.7.1')
    expect(seen[1]!.has('X-Marcapony-Sdk')).toBe(false)
  })
})

describe('projectSdkVersion', () => {
  it('reads the installed SDK first', () => {
    mkdirSync(join(dir, 'node_modules', 'marcapony-sdk'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'marcapony-sdk', 'package.json'), '{"version":"0.6.2"}')
    writeFileSync(join(dir, 'package.json'), '{"dependencies":{"marcapony-sdk":"^0.7.1"}}')
    expect(projectSdkVersion(dir)).toBe('0.6.2')
  })

  it('falls back to the range in package.json', () => {
    writeFileSync(join(dir, 'package.json'), '{"devDependencies":{"marcapony-sdk":"^0.7.1"}}')
    expect(projectSdkVersion(dir)).toBe('^0.7.1')
  })

  it('is null without the SDK, and for anything that is not a version', () => {
    writeFileSync(join(dir, 'package.json'), '{"dependencies":{"hono":"^4"}}')
    expect(projectSdkVersion(dir)).toBeNull()
    writeFileSync(join(dir, 'package.json'), '{"dependencies":{"marcapony-sdk":"workspace:*"}}')
    expect(projectSdkVersion(dir)).toBeNull()
  })
})

describe('the update check', () => {
  const on = { HOME: '/nowhere' } as NodeJS.ProcessEnv

  it('stays off with --json, in CI, under a test runner and when turned off', () => {
    expect(updateCheckEnabled(on, false)).toBe(true)
    expect(updateCheckEnabled(on, true)).toBe(false)
    expect(updateCheckEnabled({ CI: 'true' }, false)).toBe(false)
    expect(updateCheckEnabled({ NODE_ENV: 'test' }, false)).toBe(false)
    expect(updateCheckEnabled({ MARCAPONY_NO_UPDATE_CHECK: '1' }, false)).toBe(false)
  })

  it('compares versions and ignores prerelease parts', () => {
    expect(isBehind('0.11.3', '0.12.0')).toBe(true)
    expect(isBehind('0.12.0', '0.12.0')).toBe(false)
    expect(isBehind('0.12.1', '0.12.0')).toBe(false)
    expect(isBehind('0.12.0-beta.1', '0.12.0')).toBe(false)
    expect(isBehind('garbage', '0.12.0')).toBe(false)
    expect(updateLine('0.11.3', '0.12.0')).toBe(
      'Marcapony CLI 0.12.0 is available (you have 0.11.3): bun add -g marcapony@latest',
    )
    expect(updateLine('0.12.0', '0.12.0')).toBeNull()
  })

  it('asks the registry at most once a day, and caches a failure too', async () => {
    let calls = 0
    const registry = (async (_url: unknown) => {
      calls++
      return json({ version: '9.0.0' })
    }) as typeof fetch
    const start = new Date('2026-11-07T10:00:00Z')
    const options = { env: on, dir, fetchImpl: registry }
    expect(await latestCliVersion({ ...options, now: () => start })).toBe('9.0.0')
    const later = new Date(start.getTime() + UPDATE_CHECK_INTERVAL_MS - 1000)
    expect(await latestCliVersion({ ...options, now: () => later })).toBe('9.0.0')
    expect(calls).toBe(1)
    expect(JSON.parse(readFileSync(join(dir, 'update-check.json'), 'utf8')).latest).toBe('9.0.0')

    const down = (async (_url: unknown) => {
      calls++
      throw new Error('offline')
    }) as unknown as typeof fetch
    const nextDay = new Date(start.getTime() + UPDATE_CHECK_INTERVAL_MS + 1000)
    expect(await latestCliVersion({ env: on, dir, fetchImpl: down, now: () => nextDay })).toBe(
      '9.0.0',
    )
    expect(await latestCliVersion({ env: on, dir, fetchImpl: down, now: () => nextDay })).toBe(
      '9.0.0',
    )
    expect(calls).toBe(2)
  })

  it('prints one line after the command, unless the platform already said it', async () => {
    const registry = (async (_url: unknown) => json({ version: '9.0.0' })) as typeof fetch
    const printed: string[] = []
    const options = { env: on, dir, fetchImpl: registry, current: '0.12.0' }
    await startUpdateCheck({ ...options, print: (l) => printed.push(l) })(false)
    expect(printed).toEqual([
      'Marcapony CLI 9.0.0 is available (you have 0.12.0): bun add -g marcapony@latest',
    ])
    await startUpdateCheck({ ...options, print: (l) => printed.push(l) })(true)
    expect(printed).toHaveLength(1)
  })

  it('never runs with --json', async () => {
    let calls = 0
    const registry = (async (_url: unknown) => {
      calls++
      return json({ version: '9.0.0' })
    }) as typeof fetch
    expect(await latestCliVersion({ env: on, dir, json: true, fetchImpl: registry })).toBeNull()
    expect(calls).toBe(0)
  })
})

describe('deploy notices', () => {
  it('prints the platform’s notices as warnings and returns them in the result', async () => {
    mkdirSync(join(dir, 'dist'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'marcapony-sdk'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'marcapony-sdk', 'package.json'), '{"version":"0.5.0"}')
    writeFileSync(join(dir, 'dist', 'index.js'), 'export default {}')
    writeFileSync(join(dir, '.dev.vars'), 'MARCAPONY_API_KEY=mpk_secret\n')
    writeFileSync(
      join(dir, 'marcapony.json'),
      JSON.stringify({ app: 'shop', build: 'echo build', worker: 'dist/index.js' }),
    )
    const notice = {
      kind: 'sdk_update',
      current: '0.5.0',
      latest: '0.7.1',
      command: 'bun add marcapony-sdk@latest',
    }
    let sdkHeader = null as string | null
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/source-head')) return json({ data: { enabled: false, branch: 'x' } })
      if (u.endsWith('/validate')) return json({ data: { ok: true } })
      if (u.endsWith('/ext/v1/deployments')) {
        sdkHeader = new Headers(init?.headers).get('X-Marcapony-Sdk')
        return json(
          {
            data: {
              id: 'd',
              status: 'live',
              hostname: null,
              error: null,
              warnings: ['This app uses marcapony-sdk 0.5.0; 0.7.1 is available.'],
              notices: [notice],
            },
          },
          201,
        )
      }
      throw new Error(`unexpected ${u}`)
    }) as typeof fetch
    const lines: string[] = []
    const result = await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl,
      runBuild: () => {},
      log: (m) => lines.push(m),
      source: false,
    })
    expect(sdkHeader).toBe('0.5.0')
    expect(lines).toContain('Warning: This app uses marcapony-sdk 0.5.0; 0.7.1 is available.')
    expect(result.notices).toEqual([notice] as typeof result.notices)
  })
})
