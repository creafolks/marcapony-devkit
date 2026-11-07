import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError, EXIT, describeMovedBy, type SourceHead } from '../api'
import { runDeployDetailed } from '../deploy'
import { readBase, writeBase } from '../lock'
import { diffLines, mergeText, unifiedDiff } from '../merge'
import { runPull } from '../pull'
import { runStatus } from '../status'
import type { PushSourceOptions } from '../source'

// The team sync rule on the CLI side: the deploy order (validate, head check,
// build, push on the base, deploy, save the base), `marcapony.lock`, the
// vendored three-way merge and `marcapony app pull`.

const ENV_ID = '11111111-1111-4111-8111-111111111111'
const sha = (c: string) => c.repeat(40)

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
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

/** Routes by URL suffix; every call is recorded. */
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

const GRANT = {
  repoName: 'app-1',
  remote: 'https://r/git/ns/app-1.git',
  branch: 'test',
  token: 'art_v1_x?expires=1',
  expiresAt: null,
  grantId: 'grant-1',
  headBefore: sha('a'),
}
const LIVE = { data: { id: 'dep-1', status: 'live', hostname: null, error: null } }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'marcapony-sync-'))
  mkdirSync(join(dir, 'dist'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'index.js'), 'export default {}')
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, '.dev.vars'), 'MARCAPONY_API_KEY=mpk_secret\n')
  writeFileSync(
    join(dir, 'marcapony.json'),
    JSON.stringify({ app: 'transfer-app', build: 'echo build', worker: 'dist/index.js' }),
  )
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('marcapony.lock', () => {
  it('keeps one base per environment, sorted, and survives a missing file', () => {
    expect(readBase(dir, ENV_ID)).toBeUndefined()
    writeBase(dir, 'z-env', sha('1'), new Date('2026-11-06T10:00:00Z'))
    writeBase(dir, ENV_ID, sha('2'), new Date('2026-11-06T10:00:00Z'))
    const lock = JSON.parse(readFileSync(join(dir, 'marcapony.lock'), 'utf8'))
    expect(Object.keys(lock.environments)).toEqual([ENV_ID, 'z-env'])
    expect(readBase(dir, ENV_ID)).toEqual({ base: sha('2'), syncedAt: '2026-11-06T10:00:00.000Z' })
  })
})

describe('runDeployDetailed with the sync rule', () => {
  function deployRoutes(head: SourceHead, pushed: PushSourceOptions[] = []) {
    const r = router({
      '/source-head': () => json({ data: head }),
      '/validate': () => json({ data: { ok: true } }),
      '/source-token': () => json({ data: GRANT }, 201),
      '/source-token/grant-1/close': () => json({ data: { outcome: 'ok', headAfter: sha('c') } }),
      '/ext/v1/deployments': () => json(LIVE, 201),
    })
    return { ...r, pushed }
  }

  it('pushes on top of the base, deploys with it and saves the new base', async () => {
    writeBase(dir, ENV_ID, sha('a'))
    const pushed: PushSourceOptions[] = []
    const { fetch, calls } = deployRoutes(headOf())
    const result = await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      runBuild: () => {},
      log: () => {},
      pushSourceImpl: async (o) => {
        pushed.push(o)
        return sha('c')
      },
    })
    expect(pushed[0]?.parent).toBe(sha('a'))
    const order = calls.map((c) => c.url.replace('http://localhost:4000/ext/v1/deployments', ''))
    expect(order).toEqual([
      '/source-head',
      '/validate',
      '/source-token',
      '/source-token/grant-1/close',
      '',
    ])
    const deploy = calls[calls.length - 1]!.body as Record<string, unknown>
    expect(deploy.baseSourceRef).toBe(sha('a'))
    expect((deploy.source as Record<string, unknown>).grantId).toBe('grant-1')
    expect(result.source?.commit).toBe(sha('c'))
    expect(readBase(dir, ENV_ID)?.base).toBe(sha('c'))
  })

  it('stops before the build with exit code 2 when someone deployed since the last sync', async () => {
    writeBase(dir, ENV_ID, sha('a'))
    const { fetch, calls } = deployRoutes(
      headOf({
        head: sha('b'),
        movedBy: { name: 'Ayşe', version: 15, at: '2026-11-06', forced: false },
      }),
    )
    const built: string[] = []
    const err = await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      runBuild: (c) => built.push(c),
      log: () => {},
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).exitCode).toBe(EXIT.remoteChanges)
    expect((err as CliError).message).toContain('Ayşe deployed version 15')
    expect(built).toEqual([])
    expect(calls.some((c) => c.url.endsWith('/source-token'))).toBe(false)
  })

  it('says a git push landed when a deploy key pushed and its build has not deployed yet', async () => {
    writeBase(dir, ENV_ID, sha('a'))
    const { fetch } = deployRoutes(
      headOf({
        head: sha('b'),
        movedBy: { kind: 'push', name: null, version: null, at: '2026-11-08', forced: true },
      }),
    )
    const err = await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      runBuild: () => {},
      log: () => {},
    }).catch((e: unknown) => e)
    expect((err as CliError).exitCode).toBe(EXIT.remoteChanges)
    expect((err as CliError).message).toContain('A forced git push landed after your last sync')
  })

  it("says an approved change landed, and who approved it, when the head is the platform's commit", async () => {
    writeBase(dir, ENV_ID, sha('a'))
    const { fetch } = deployRoutes(
      headOf({
        head: sha('b'),
        movedBy: {
          kind: 'proposal',
          proposalId: 'p-1',
          proposedBy: 'marco',
          name: 'Ayşe',
          version: 7,
          at: '2026-11-07',
          forced: false,
        },
      }),
    )
    const err = await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      runBuild: () => {},
      log: () => {},
    }).catch((e: unknown) => e)
    expect((err as CliError).exitCode).toBe(EXIT.remoteChanges)
    expect((err as CliError).message).toContain(
      "Marco's change, approved by Ayşe (version 7) landed after your last sync",
    )
  })

  it('asks for one pull when the project never synced with an environment that has source', async () => {
    const { fetch } = deployRoutes(headOf())
    const err = await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      runBuild: () => {},
      log: () => {},
    }).catch((e: unknown) => e)
    expect((err as CliError).exitCode).toBe(EXIT.remoteChanges)
    expect((err as CliError).message).toContain('marcapony app pull')
  })

  it('with --force pushes on top of the head and says so to the server', async () => {
    writeBase(dir, ENV_ID, sha('a'))
    const pushed: PushSourceOptions[] = []
    const { fetch, calls } = deployRoutes(headOf({ head: sha('b') }))
    await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      force: true,
      fetchImpl: fetch,
      runBuild: () => {},
      log: () => {},
      pushSourceImpl: async (o) => {
        pushed.push(o)
        return sha('c')
      },
    })
    expect(pushed[0]?.parent).toBe(sha('b'))
    const deploy = calls[calls.length - 1]!.body as Record<string, unknown>
    expect(deploy.force).toBe(true)
    expect(deploy.baseSourceRef).toBe(sha('a'))
  })

  it('needs no pull for the first deploy of an empty branch', async () => {
    const pushed: PushSourceOptions[] = []
    const { fetch } = deployRoutes(headOf({ head: null }))
    await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      runBuild: () => {},
      log: () => {},
      pushSourceImpl: async (o) => {
        pushed.push(o)
        return sha('c')
      },
    })
    expect(pushed[0]?.parent).toBeNull()
    expect(readBase(dir, ENV_ID)?.base).toBe(sha('c'))
  })

  it('refuses to deploy a file that still has conflict markers', async () => {
    writeBase(dir, ENV_ID, sha('a'))
    writeFileSync(join(dir, 'src', 'app.ts'), '<<<<<<< yours\na\n=======\nb\n>>>>>>> marcapony\n')
    const { fetch } = deployRoutes(headOf())
    const err = await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      runBuild: () => {},
      log: () => {},
    }).catch((e: unknown) => e)
    expect((err as CliError).exitCode).toBe(EXIT.conflicts)
  })

  it('maps a server refusal of the claim to exit code 2', async () => {
    writeBase(dir, ENV_ID, sha('a'))
    const r = router({
      '/source-head': () => json({ data: headOf() }),
      '/validate': () =>
        json(
          {
            error: {
              code: 'remote_changes',
              message: 'The branch has commits you have not pulled',
            },
          },
          409,
        ),
    })
    const err = await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      source: false,
      fetchImpl: r.fetch,
      runBuild: () => {},
      log: () => {},
    }).catch((e: unknown) => e)
    expect((err as CliError).exitCode).toBe(EXIT.remoteChanges)
  })

  it('when the route is not there (400) pushes on top of the remote head, as 0.5 did', async () => {
    const pushed: PushSourceOptions[] = []
    const r = router({
      // A platform that answers the route with 400 (it is not there): no sync rule.
      '/source-head': () => json({ error: { code: 'validation_failed', message: 'bad id' } }, 400),
      '/validate': () => json({ error: { code: 'not_found', message: 'no route' } }, 404),
      '/source-token': () =>
        json({ data: { ...GRANT, grantId: undefined, headBefore: undefined } }, 201),
      '/ext/v1/deployments': () => json(LIVE, 201),
    })
    await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: r.fetch,
      runBuild: () => {},
      log: () => {},
      pushSourceImpl: async (o) => {
        pushed.push(o)
        return sha('c')
      },
    })
    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.parent).toBeUndefined()
  })

  it('records the pushed commit as the base even when the deploy then fails', async () => {
    writeBase(dir, ENV_ID, sha('a'))
    const r = router({
      '/source-head': () => json({ data: headOf() }),
      '/validate': () => json({ data: { ok: true } }),
      '/source-token': () => json({ data: GRANT }, 201),
      '/source-token/grant-1/close': () => json({ data: { outcome: 'ok', headAfter: sha('c') } }),
      '/ext/v1/deployments': () =>
        json({ error: { code: 'server_error', message: 'upload failed' } }, 500),
    })
    const err = await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: r.fetch,
      runBuild: () => {},
      log: () => {},
      pushSourceImpl: async () => sha('c'),
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    // The branch head is this project's own commit now; the next deploy must not stop on it.
    expect(readBase(dir, ENV_ID)?.base).toBe(sha('c'))
  })

  it('is refused as not linked with exit code 5', async () => {
    rmSync(join(dir, 'marcapony.json'))
    const err = await runDeployDetailed({ cwd: dir, env: {}, log: () => {} }).catch(
      (e: unknown) => e,
    )
    expect((err as CliError).exitCode).toBe(EXIT.notLinked)
  })
})

describe('mergeText', () => {
  const labels = { ours: 'yours', base: 'base', theirs: 'marcapony' }

  it('takes non-overlapping changes from both sides', () => {
    const base = 'a\nb\nc\nd\ne\n'
    const ours = 'A\nb\nc\nd\ne\n'
    const theirs = 'a\nb\nc\nd\nE\n'
    expect(mergeText(ours, base, theirs, labels)).toEqual({ text: 'A\nb\nc\nd\nE\n', conflicts: 0 })
  })

  it('writes diff3 markers when both sides change the same line', () => {
    const result = mergeText('x\nB1\ny\n', 'x\nb\ny\n', 'x\nB2\ny\n', labels)
    expect(result.conflicts).toBe(1)
    expect(result.text).toBe(
      'x\n<<<<<<< yours\nB1\n||||||| base\nb\n=======\nB2\n>>>>>>> marcapony\ny\n',
    )
  })

  it('accepts the same change made on both sides', () => {
    expect(mergeText('x\nB\n', 'x\nb\n', 'x\nB\n', labels)).toEqual({
      text: 'x\nB\n',
      conflicts: 0,
    })
  })

  it('handles insertions and deletions', () => {
    const result = mergeText('a\nb\nc\nnew\nd\ne\n', 'a\nb\nc\nd\ne\n', 'a\nc\nd\ne\n', labels)
    expect(result).toEqual({ text: 'a\nc\nnew\nd\ne\n', conflicts: 0 })
  })

  it('treats touching changes as a conflict, as git does', () => {
    expect(mergeText('a\nb\nnew\nc\n', 'a\nb\nc\n', 'a\nc\n', labels).conflicts).toBe(1)
  })
})

describe('diffLines and unifiedDiff', () => {
  it('finds the changed regions', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { aStart: 1, aLen: 1, bStart: 1, bLen: 1 },
    ])
    expect(diffLines([], ['a'])).toEqual([{ aStart: 0, aLen: 0, bStart: 0, bLen: 1 }])
  })

  it('prints a unified diff', () => {
    expect(unifiedDiff('f.ts', 'a\nb\nc\n', 'a\nB\nc\n')).toBe(
      'diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
    )
  })
})

describe('runPull', () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  const remote = (base: Record<string, string>, theirs: Record<string, string>) =>
    (async () => [
      new Map(Object.entries(base).map(([k, v]) => [k, enc(v)])),
      new Map(Object.entries(theirs).map(([k, v]) => [k, enc(v)])),
    ]) as never

  function pullRoutes(head: SourceHead) {
    return router({
      '/source-head': () => json({ data: head }),
      '/source-read-token': () => json({ data: { ...GRANT, token: 'art_v1_r' } }, 201),
    })
  }

  it('merges remote changes into untouched files and moves the base', async () => {
    writeBase(dir, ENV_ID, sha('0'))
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const a = 1\n')
    const { fetch } = pullRoutes(headOf({ head: sha('a') }))
    const result = await runPull({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      log: () => {},
      useGit: false,
      readRemote: remote(
        { 'src/app.ts': 'export const a = 1\n' },
        { 'src/app.ts': 'export const a = 2\n', 'src/new.ts': 'n\n' },
      ),
    })
    expect(result.status).toBe('merged')
    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toBe('export const a = 2\n')
    expect(readFileSync(join(dir, 'src', 'new.ts'), 'utf8')).toBe('n\n')
    expect(readBase(dir, ENV_ID)?.base).toBe(sha('a'))
  })

  it('names a forced git push without nested parentheses', async () => {
    writeBase(dir, ENV_ID, sha('0'))
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const a = 1\n')
    const { fetch } = pullRoutes(
      headOf({
        head: sha('a'),
        movedBy: { kind: 'push', name: null, version: null, at: 'x', forced: true },
      }),
    )
    const logged: string[] = []
    await runPull({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      log: (line: string) => logged.push(line),
      useGit: false,
      readRemote: remote(
        { 'src/app.ts': 'export const a = 1\n' },
        { 'src/app.ts': 'export const a = 2\n' },
      ),
    })
    expect(logged[0]).toBe(`Pulled ${sha('a').slice(0, 7)} (A forced git push):`)
  })

  it('leaves conflict markers and reports the conflicts', async () => {
    writeBase(dir, ENV_ID, sha('0'))
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const a = 3\n')
    const { fetch } = pullRoutes(headOf({ head: sha('a') }))
    const result = await runPull({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      log: () => {},
      useGit: false,
      readRemote: remote(
        { 'src/app.ts': 'export const a = 1\n' },
        { 'src/app.ts': 'export const a = 2\n' },
      ),
    })
    expect(result.status).toBe('conflicts')
    expect(result.files).toEqual([{ path: 'src/app.ts', action: 'conflict', conflicts: 1 }])
    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toContain('<<<<<<< yours')
    expect(result.conflicts).toEqual({
      headCommit: sha('a'),
      files: [
        {
          path: 'src/app.ts',
          regions: [
            {
              id: 0,
              base: 'export const a = 1\n',
              ours: 'export const a = 3\n',
              theirs: 'export const a = 2\n',
            },
          ],
        },
      ],
    })
  })

  it('only moves the base when the files already contain the change', async () => {
    writeBase(dir, ENV_ID, sha('0'))
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const a = 2\n')
    const logs: string[] = []
    const { fetch } = pullRoutes(headOf({ head: sha('a') }))
    const result = await runPull({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      log: (m) => logs.push(m),
      useGit: false,
      readRemote: remote(
        { 'src/app.ts': 'export const a = 1\n' },
        { 'src/app.ts': 'export const a = 2\n' },
      ),
    })
    expect(result.files).toEqual([{ path: 'src/app.ts', action: 'unchanged' }])
    expect(logs[0]).toContain('already contain')
    expect(readBase(dir, ENV_ID)?.base).toBe(sha('a'))
  })

  it('is up to date when the base is the head', async () => {
    writeBase(dir, ENV_ID, sha('a'))
    const { fetch, calls } = pullRoutes(headOf())
    const result = await runPull({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      log: () => {},
    })
    expect(result.status).toBe('up_to_date')
    expect(calls.some((c) => c.url.endsWith('/source-read-token'))).toBe(false)
  })

  it('never merges a blocked head', async () => {
    writeBase(dir, ENV_ID, sha('0'))
    const { fetch } = pullRoutes(headOf({ scan: 'blocked' }))
    const err = await runPull({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      log: () => {},
    }).catch((e: unknown) => e)
    expect((err as CliError).exitCode).toBe(EXIT.refused)
  })

  it('prints a patch with --patch and changes nothing', async () => {
    writeBase(dir, ENV_ID, sha('0'))
    const { fetch } = pullRoutes(headOf())
    const result = await runPull({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      log: () => {},
      patch: true,
      readRemote: remote(
        { 'src/app.ts': 'export const a = 1\n' },
        { 'src/app.ts': 'export const a = 2\n' },
      ),
    })
    expect(result.patch).toContain('+export const a = 2')
    expect(readBase(dir, ENV_ID)?.base).toBe(sha('0'))
  })
})

describe('runStatus', () => {
  it('says what to run next', async () => {
    writeBase(dir, ENV_ID, sha('0'))
    const r = router({ '/source-head': () => json({ data: headOf() }) })
    const result = await runStatus({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: r.fetch,
      log: () => {},
    })
    expect(result.state).toBe('behind')
    expect(result.next).toBe('marcapony app pull')
  })

  it('adds ", forced" to a forced deploy but not to a push, which says it itself', async () => {
    writeBase(dir, ENV_ID, sha('0'))
    const lines = async (movedBy: SourceHead['movedBy']) => {
      const logged: string[] = []
      const r = router({ '/source-head': () => json({ data: headOf({ movedBy }) }) })
      await runStatus({
        cwd: dir,
        cliEnv: 'local',
        env: {},
        fetchImpl: r.fetch,
        log: (line: string) => logged.push(line),
      })
      return logged.map((l) => l.trim())
    }
    const push = await lines({ kind: 'push', name: null, version: null, at: 'x', forced: true })
    expect(push).toContain('A forced git push')
    expect(push.some((l) => l.includes(', forced'))).toBe(false)
    const deploy = await lines({ name: 'Ayşe', version: 15, at: 'x', forced: true })
    expect(deploy).toContain('Ayşe deployed version 15, forced')
  })
})

describe('marcapony app env', () => {
  it('sets a secret from the reader, never from an argument, and lists without secret values', async () => {
    const { runEnvList, runEnvSet } = await import('../env')
    const r = router({
      '/environment-values/IYZICO_API_KEY': () => json({ data: { live: 'applied' } }),
      '/environment-values': () =>
        json({
          data: [
            {
              name: 'IYZICO_API_KEY',
              kind: 'secret',
              value: null,
              updatedAt: 'now',
              updatedBy: null,
            },
            { name: 'FLAG', kind: 'setting', value: 'on', updatedAt: 'now', updatedBy: null },
          ],
        }),
    })
    const logs: string[] = []
    const set = await runEnvSet({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: r.fetch,
      log: (m) => logs.push(m),
      name: 'IYZICO_API_KEY',
      secret: true,
      readValue: async () => 'sk_live_1',
    })
    expect(set.live).toBe('applied')
    expect(r.calls[0]?.body).toEqual({ kind: 'secret', value: 'sk_live_1' })
    expect(logs.join('\n')).not.toContain('sk_live_1')

    const listed = await runEnvList({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: r.fetch,
      log: (m) => logs.push(m),
    })
    expect(listed.find((v) => v.name === 'FLAG')?.value).toBeNull()
  })

  it('refuses a reserved or malformed name before asking for the value', async () => {
    const { runEnvSet } = await import('../env')
    let asked = false
    const err = await runEnvSet({
      cwd: dir,
      env: {},
      log: () => {},
      name: 'MARCAPONY_X',
      readValue: async () => {
        asked = true
        return 'v'
      },
    }).catch((e: unknown) => e)
    expect((err as CliError).exitCode).toBe(EXIT.refused)
    expect(asked).toBe(false)
  })
})

describe('describeMovedBy', () => {
  it('names a deploy, an approved change and a change not built yet', () => {
    expect(describeMovedBy({ name: 'Ayşe', version: 15, at: 'x', forced: false })).toBe(
      'Ayşe deployed version 15',
    )
    expect(
      describeMovedBy({
        kind: 'proposal',
        proposedBy: 'mcp',
        name: null,
        version: null,
        at: 'x',
        forced: false,
      }),
    ).toBe("An AI agent's change, approved by someone")
    expect(
      describeMovedBy({ kind: 'proposal', name: 'Ayşe', version: 3, at: 'x', forced: false }),
    ).toBe('An approved change, approved by Ayşe (version 3)')
  })

  it('names a git push whose build has not deployed yet', () => {
    expect(
      describeMovedBy({ kind: 'push', name: 'Ayşe', version: null, at: 'x', forced: true }),
    ).toBe('Ayşe force-pushed')
    expect(
      describeMovedBy({ kind: 'push', name: null, version: null, at: 'x', forced: true }),
    ).toBe('A forced git push')
    expect(
      describeMovedBy({ kind: 'push', name: null, version: null, at: 'x', forced: false }),
    ).toBe('A git push')
  })

  it('keeps the old wording for a head an older platform reports without a kind', () => {
    expect(describeMovedBy({ name: null, version: null, at: 'x', forced: true })).toBe(
      'Someone deployed',
    )
  })
})
