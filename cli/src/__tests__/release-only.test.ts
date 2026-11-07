import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError, EXIT, type SourceHead } from '../api'
import { runDeployDetailed } from '../deploy'
import { parseArgs } from '../index'
import { writeBase } from '../lock'

// A production that goes live through releases: a plain deploy is refused
// with exit code 4 and a hint, and --direct asks for the one-time direct
// deploy on every route that checks the rule.

const ENV_ID = '11111111-1111-4111-8111-111111111111'
const sha = (c: string) => c.repeat(40)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function router(routes: Record<string, (init: RequestInit) => Response>): {
  fetch: typeof fetch
  calls: Array<{ url: string; body: unknown }>
} {
  const calls: Array<{ url: string; body: unknown }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const match = Object.entries(routes)
      .sort(([a], [b]) => b.length - a.length)
      .find(([suffix]) => u.endsWith(suffix))
    if (!match) throw new Error(`unexpected request ${u}`)
    return match[1](init ?? {})
  }) as typeof fetch
  return { fetch: impl, calls }
}

const HEAD: SourceHead = {
  enabled: true,
  environmentId: ENV_ID,
  branch: 'production',
  head: sha('a'),
  stale: false,
  scan: null,
  movedBy: null,
  rewrites: {},
}
const GRANT = {
  repoName: 'app-1',
  remote: 'https://r/git/ns/app-1.git',
  branch: 'production',
  token: 'art_v1_x?expires=1',
  expiresAt: null,
  grantId: 'grant-1',
  headBefore: sha('a'),
}
const LIVE = { data: { id: 'dep-1', status: 'live', hostname: null, error: null } }
const RELEASE_ONLY = {
  error: {
    code: 'release_only',
    message:
      "This app goes live through releases. Deploy to test, then use 'Canlıya al' in the dashboard.",
  },
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'marcapony-release-only-'))
  mkdirSync(join(dir, 'dist'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'index.js'), 'export default {}')
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, '.dev.vars'), 'MARCAPONY_API_KEY=mpk_secret\n')
  writeFileSync(
    join(dir, 'marcapony.json'),
    JSON.stringify({ app: 'release-app', build: 'echo build', worker: 'dist/index.js' }),
  )
  writeBase(dir, ENV_ID, sha('a'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('deploy to a release-only production', () => {
  it('is refused before the build with exit code 4, naming --direct', async () => {
    let built = false
    const r = router({
      '/source-head': () => json({ data: HEAD }),
      '/validate': () => json(RELEASE_ONLY, 409),
    })
    const err = await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: r.fetch,
      runBuild: () => {
        built = true
      },
      log: () => {},
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).exitCode).toBe(EXIT.refused)
    expect((err as CliError).code).toBe('release_only')
    expect((err as CliError).message).toContain("'Canlıya al'")
    expect((err as CliError).message).toContain('marcapony app deploy --direct')
    expect(built).toBe(false)
  })

  it('with --direct sends direct on validate, the source token and the deploy', async () => {
    const r = router({
      '/source-head': () => json({ data: HEAD }),
      '/validate': () => json({ data: { ok: true } }),
      '/source-token?direct=true': () => json({ data: GRANT }, 201),
      '/source-token/grant-1/close': () => json({ data: { outcome: 'ok', headAfter: sha('c') } }),
      '/ext/v1/deployments': () => json(LIVE, 201),
    })
    await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      direct: true,
      fetchImpl: r.fetch,
      runBuild: () => {},
      log: () => {},
      pushSourceImpl: async () => sha('c'),
    })
    const bodyOf = (suffix: string) =>
      (r.calls.find((c) => c.url.endsWith(suffix))?.body ?? {}) as Record<string, unknown>
    expect(bodyOf('/validate').direct).toBe(true)
    expect(r.calls.some((c) => c.url.endsWith('/source-token?direct=true'))).toBe(true)
    expect(bodyOf('/ext/v1/deployments').direct).toBe(true)
  })

  it('without --direct sends no direct field anywhere', async () => {
    const r = router({
      '/source-head': () => json({ data: HEAD }),
      '/validate': () => json({ data: { ok: true } }),
      '/source-token': () => json({ data: GRANT }, 201),
      '/source-token/grant-1/close': () => json({ data: { outcome: 'ok', headAfter: sha('c') } }),
      '/ext/v1/deployments': () => json(LIVE, 201),
    })
    await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: r.fetch,
      runBuild: () => {},
      log: () => {},
      pushSourceImpl: async () => sha('c'),
    })
    expect(r.calls.some((c) => c.url.includes('direct=true'))).toBe(false)
    for (const call of r.calls) {
      expect((call.body as Record<string, unknown> | undefined)?.direct).toBeUndefined()
    }
  })

  it('with --direct and no allowance says to allow one first', async () => {
    const r = router({
      '/source-head': () => json({ data: HEAD }),
      '/validate': () =>
        json(
          {
            error: {
              code: 'release_only',
              message: 'No one-time direct deploy is allowed for this app right now.',
            },
          },
          409,
        ),
    })
    const err = await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      direct: true,
      source: false,
      fetchImpl: r.fetch,
      runBuild: () => {},
      log: () => {},
    }).catch((e: unknown) => e)
    expect((err as CliError).exitCode).toBe(EXIT.refused)
    expect((err as CliError).message).toContain('30 minutes')
  })

  it('parses --direct as a flag that takes no value', () => {
    expect(parseArgs(['app', 'deploy', '--direct', '--json'])).toEqual({
      command: ['app', 'deploy'],
      flags: { direct: true, json: true },
    })
  })
})
