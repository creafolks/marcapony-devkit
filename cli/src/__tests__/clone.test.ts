import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import git from 'isomorphic-git'
import * as fs from 'node:fs'
import { type CliError, EXIT, type SourceHead } from '../api'
import { runClone } from '../clone'
import { runDeployDetailed } from '../deploy'
import { localGitHead, readBase } from '../lock'

// `marcapony app clone`, and a clone's checked-out commit as the base.

const ENV_ID = '11111111-1111-4111-8111-111111111111'
const sha = (c: string) => c.repeat(40)
const _MB = 1024 * 1024
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

describe('a clone as the base', () => {
  async function commitIn(path: string): Promise<string> {
    await git.init({ fs, dir: path, defaultBranch: 'test' })
    writeFileSync(join(path, 'a.txt'), 'a')
    await git.add({ fs, dir: path, filepath: 'a.txt' })
    return git.commit({
      fs,
      dir: path,
      message: 'one',
      author: { name: 'x', email: 'x@example.com' },
    })
  }

  it('reads the checked-out commit from .git without a git binary', async () => {
    expect(localGitHead(dir)).toBeNull()
    const commit = await commitIn(dir)
    expect(localGitHead(dir)).toBe(commit)
  })

  it('takes the HEAD of a clone of the branch as the base when the lock has none', async () => {
    const commit = await commitIn(dir)
    writeProject()
    const { fetch } = router({
      '/source-head': () => json({ data: headOf({ head: commit }) }),
      '/validate': () => json({ data: { ok: true } }),
      '/ext/v1/deployments': () => json(LIVE, 201),
    })
    const result = await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      runBuild: () => {},
      log: () => {},
      source: false,
    })
    expect(result.base).toBe(commit)
  })
})

describe('marcapony app clone', () => {
  const routes = (key: string) => ({
    '/apps/link': () =>
      json({ appSlug: 'shop', environmentName: 'test', key, baseUrl: 'http://x/ext/v1' }),
    '/source-head': () => json({ data: headOf({ head: sha('a') }) }),
    '/source-read-token': () =>
      json(
        {
          data: {
            repoName: 'app-1',
            remote: 'https://r/git/ns/app-1.git',
            branch: 'test',
            token: 'art_v1_readsecret?expires=1',
            expiresAt: null,
          },
        },
        201,
      ),
    '/keys/retire-previous': () => json({ data: { revoked: 0 } }),
    '/capabilities': () => json({ data: [] }),
  })

  it('clones the branch, links the clone, writes the base and never leaks the token', async () => {
    const lines: string[] = []
    let auth: { username?: string; password?: string } | undefined
    let url = ''
    const { fetch } = router(routes('mpk_newkey'))
    const result = await runClone({
      cwd: dir,
      dir: 'shop',
      code: 'mpl_code',
      cliEnv: 'local',
      fetchImpl: fetch,
      log: (m) => lines.push(m),
      clone: (async (args: Parameters<typeof git.clone>[0]) => {
        url = args.url
        auth = (args.onAuth as () => { username: string; password: string })()
        await git.init({ fs, dir: args.dir, defaultBranch: 'test' })
        writeFileSync(
          join(args.dir, 'marcapony.json'),
          JSON.stringify({ manifest: 2, app: 'shop', build: 'bun run build', server: 'dist/s.js' }),
        )
        await git.add({ fs, dir: args.dir, filepath: 'marcapony.json' })
        await git.commit({
          fs,
          dir: args.dir,
          message: 'snapshot',
          author: { name: 'x', email: 'x@example.com' },
        })
      }) as typeof git.clone,
    })
    const clone = join(dir, 'shop')
    expect(result.dir).toBe(clone)
    expect(auth).toEqual({ username: 'x', password: 'art_v1_readsecret' })
    expect(url).not.toContain('art_v1')
    expect(readFileSync(join(clone, '.env.local'), 'utf8')).toContain(
      'MARCAPONY_API_KEY=mpk_newkey',
    )
    expect(readBase(clone, ENV_ID)?.base).toBe(result.head)
    expect(readFileSync(join(clone, '.git', 'config'), 'utf8')).not.toContain('readsecret')
    expect(lines.join('\n')).not.toContain('readsecret')
    expect(lines.join('\n')).not.toContain('mpk_newkey')
  })

  it('refuses a directory that is not empty before using the pairing code', async () => {
    mkdirSync(join(dir, 'taken'))
    writeFileSync(join(dir, 'taken', 'x'), 'x')
    const { fetch, calls } = router(routes('mpk_k'))
    const err = await runClone({
      cwd: dir,
      dir: 'taken',
      code: 'mpl_code',
      fetchImpl: fetch,
    }).catch((e: unknown) => e)
    expect((err as Error).message).toContain('not empty')
    expect(calls).toEqual([])
  })

  it('says so when the environment has no saved source, and leaves no directory', async () => {
    const { fetch } = router({ ...routes('mpk_k'), '/source-read-token': () => json({}, 404) })
    const err = await runClone({
      cwd: dir,
      dir: 'shop',
      code: 'mpl_code',
      cliEnv: 'local',
      fetchImpl: fetch,
      log: () => {},
    }).catch((e: unknown) => e)
    expect((err as CliError).exitCode).toBe(EXIT.refused)
    expect((err as CliError).message).toContain('revoke it from the app page')
    expect(existsSync(join(dir, 'shop'))).toBe(false)
  })

  it('needs a directory, checked before the pairing code is used', async () => {
    const { fetch, calls } = router(routes('mpk_k'))
    const err = await runClone({ cwd: dir, code: 'mpl_code', fetchImpl: fetch }).catch(
      (e: unknown) => e,
    )
    expect((err as Error).message).toContain('Usage')
    expect(calls).toEqual([])
  })

  it('does not clone a head the platform blocked', async () => {
    const { fetch, calls } = router({
      ...routes('mpk_k'),
      '/source-head': () => json({ data: headOf({ head: sha('a'), scan: 'blocked' }) }),
    })
    let cloned = false
    const err = await runClone({
      cwd: dir,
      dir: 'shop',
      code: 'mpl_code',
      cliEnv: 'local',
      fetchImpl: fetch,
      log: () => {},
      clone: (async () => {
        cloned = true
      }) as unknown as typeof git.clone,
    }).catch((e: unknown) => e)
    expect((err as CliError).code).toBe('source_blocked')
    expect(cloned).toBe(false)
    // No read token is minted for a clone that is refused.
    expect(calls.some((url) => url.endsWith('/source-read-token'))).toBe(false)
    expect(existsSync(join(dir, 'shop'))).toBe(false)
  })

  it('names the unsaved key when the read token is refused', async () => {
    const { fetch } = router({
      ...routes('mpk_k'),
      '/source-read-token': () =>
        json({ error: { code: 'rate_limited', message: 'Too many read tokens' } }, 429),
    })
    const err = await runClone({
      cwd: dir,
      dir: 'shop',
      code: 'mpl_code',
      cliEnv: 'local',
      fetchImpl: fetch,
      log: () => {},
    }).catch((e: unknown) => e)
    expect((err as CliError).code).toBe('rate_limited')
    expect((err as CliError).message).toContain('revoke it from the app page')
    expect(existsSync(join(dir, 'shop'))).toBe(false)
  })

  it('empties a directory that existed when the clone fails', async () => {
    mkdirSync(join(dir, 'empty'))
    const { fetch } = router(routes('mpk_k'))
    const err = await runClone({
      cwd: dir,
      dir: 'empty',
      code: 'mpl_code',
      cliEnv: 'local',
      fetchImpl: fetch,
      log: () => {},
      clone: (async (args: Parameters<typeof git.clone>[0]) => {
        writeFileSync(join(args.dir, 'partial.txt'), 'x')
        throw new Error('network down')
      }) as typeof git.clone,
    }).catch((e: unknown) => e)
    expect((err as Error).message).toContain('Clone failed: network down')
    expect(existsSync(join(dir, 'empty'))).toBe(true)
    expect(readdirSync(join(dir, 'empty'))).toEqual([])
  })

  it('warns when the branch moved during the clone, and keeps the cloned commit as base', async () => {
    const lines: string[] = []
    const { fetch } = router(routes('mpk_k'))
    const result = await runClone({
      cwd: dir,
      dir: 'shop',
      code: 'mpl_code',
      cliEnv: 'local',
      fetchImpl: fetch,
      log: (m) => lines.push(m),
      clone: (async (args: Parameters<typeof git.clone>[0]) => {
        await git.init({ fs, dir: args.dir, defaultBranch: 'test' })
        writeFileSync(join(args.dir, 'a.txt'), 'a')
        await git.add({ fs, dir: args.dir, filepath: 'a.txt' })
        await git.commit({
          fs,
          dir: args.dir,
          message: 'newer',
          author: { name: 'x', email: 'x@example.com' },
        })
      }) as typeof git.clone,
    })
    expect(result.head).not.toBe(sha('a'))
    expect(readBase(join(dir, 'shop'), ENV_ID)?.base).toBe(result.head)
    expect(lines.some((l) => l.includes('moved during the clone'))).toBe(true)
  })
})
