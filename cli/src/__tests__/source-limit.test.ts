import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError, EXIT, createDeployment, type SourceHead } from '../api'
import { runDeployDetailed } from '../deploy'
import { formatSourceUsage, usageLocale } from '../usage'

// The source repo's size limit as the CLI shows and handles it.

const ENV_ID = '11111111-1111-4111-8111-111111111111'
const sha = (c: string) => c.repeat(40)
const MB = 1024 * 1024
const LIVE = { data: { id: 'dep-1', status: 'live', hostname: null, error: null } }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function router(routes: Record<string, (init: RequestInit) => Response>): {
  fetch: typeof fetch
  calls: string[]
} {
  const calls: string[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push(u)
    const match = Object.entries(routes)
      .sort(([a], [b]) => b.length - a.length)
      .find(([suffix]) => u.endsWith(suffix))
    if (!match) throw new Error(`unexpected request ${u}`)
    return match[1](init ?? {})
  }) as typeof fetch
  return { fetch: impl, calls }
}

function headOf(overrides: Partial<SourceHead> = {}): SourceHead {
  return {
    enabled: true,
    environmentId: ENV_ID,
    branch: 'test',
    head: sha('a'),
    stale: false,
    scan: null,
    movedBy: null,
    rewrites: {},
    ...overrides,
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'marcapony-quota-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeProject(): void {
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'index.js'), 'export default {}')
  writeFileSync(join(dir, 'app.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, '.dev.vars'), 'MARCAPONY_API_KEY=mpk_secret\n')
  writeFileSync(
    join(dir, 'marcapony.json'),
    JSON.stringify({ app: 'shop', build: 'echo build', worker: 'dist/index.js' }),
  )
}

describe('formatSourceUsage', () => {
  const usage = {
    usedBytes: 12.4 * MB,
    limitBytes: 50 * MB,
    historyBytes: 20 * MB,
    measuredAt: 'x',
  }

  it('shows used, limit and what is left, with the locale decimal separator', () => {
    expect(formatSourceUsage(usage, 'en')).toBe('Source repo: 12.4 / 50 MB (37.6 MB left)')
    expect(formatSourceUsage(usage, 'tr')).toBe('Kaynak deposu: 12,4 / 50 MB (37,6 MB kaldı)')
  })

  it('says when the repo is at or over the limit', () => {
    const full = { ...usage, usedBytes: 52 * MB }
    expect(formatSourceUsage(full, 'en')).toBe('Source repo: 52.0 / 50 MB (at or over the limit)')
  })

  it('reads the locale from the environment', () => {
    expect(usageLocale({ LANG: 'tr_TR.UTF-8' })).toBe('tr')
    expect(usageLocale({ LC_ALL: 'en_US.UTF-8', LANG: 'tr_TR.UTF-8' })).toBe('en')
    expect(usageLocale({})).toBe('en')
  })
})

describe('createDeployment and the source limit', () => {
  const payload = { worker: { main: 'index.js', content: '', encoding: 'base64' as const } }

  it('waits and retries while the platform re-measures the repo', async () => {
    let attempts = 0
    const slept: number[] = []
    const { fetch } = router({
      '/ext/v1/deployments': () =>
        ++attempts === 1
          ? json({ error: { code: 'source_quota_pending', message: 'being measured' } }, 409, {
              'Retry-After': '10',
            })
          : json(LIVE, 201),
    })
    const view = await createDeployment('http://x', 'mpk', payload, fetch, async (ms) => {
      slept.push(ms)
    })
    expect(view.status).toBe('live')
    expect(slept).toEqual([10_000])
  })

  it('refuses with exit code 4 when the repo is over the limit', async () => {
    const { fetch } = router({
      '/ext/v1/deployments': () =>
        json(
          {
            error: {
              code: 'source_quota_exceeded',
              message: 'The source repo uses 52.0 of 50.0 MB',
            },
          },
          409,
        ),
    })
    const err = await createDeployment('http://x', 'mpk', payload, fetch).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).exitCode).toBe(EXIT.refused)
    expect((err as CliError).code).toBe('source_quota_exceeded')
  })
})

describe('the deploy and the source limit', () => {
  it('prints the usage after the push, and warns before the build when over the limit', async () => {
    writeProject()
    const usage = {
      usedBytes: 51 * MB,
      limitBytes: 50 * MB,
      historyBytes: 51 * MB,
      measuredAt: 'x',
    }
    const { fetch } = router({
      '/source-head': () => json({ data: headOf({ head: null, sourceUsage: usage }) }),
      '/validate': () => json({ data: { ok: true } }),
      '/source-token': () =>
        json(
          {
            data: {
              repoName: 'app-1',
              remote: 'https://r/x.git',
              branch: 'test',
              token: 'art_v1_x?expires=1',
              expiresAt: null,
              grantId: 'grant-1',
              headBefore: null,
              sourceUsage: { ...usage, usedBytes: 12.4 * MB },
            },
          },
          201,
        ),
      '/source-token/grant-1/close': () => json({ data: { outcome: 'ok', headAfter: sha('c') } }),
      '/ext/v1/deployments': () => json(LIVE, 201),
    })
    const lines: string[] = []
    await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      runBuild: () => {},
      log: (m) => lines.push(m),
      pushSourceImpl: async () => sha('c'),
    })
    const building = lines.findIndex((l) => l.startsWith('Building'))
    const warning = lines.findIndex((l) => l.includes('Deploys that save source are refused'))
    expect(warning).toBeGreaterThanOrEqual(0)
    expect(warning).toBeLessThan(building)
    expect(lines.some((l) => /^(Source repo|Kaynak deposu): 12[.,]4 \/ 50 MB/.test(l))).toBe(true)
  })
})
