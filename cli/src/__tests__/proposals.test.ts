import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CliError, EXIT, type HandedOverChangeDetail } from '../api'
import { readBase, writeBase } from '../lock'
import { runProposalPull, runProposalsList } from '../proposals'
import { readConflictRegions } from '../three-way'

// `marcapony app proposals list | pull <id>`: a handed-over change merged
// into the working tree in three ways, without moving the lock's base.

const ENV_ID = '11111111-1111-4111-8111-111111111111'
const CHANGE_ID = '22222222-2222-4222-8222-222222222222'
const BASE = 'b'.repeat(40)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function change(files: HandedOverChangeDetail['files']): HandedOverChangeDetail {
  return {
    id: CHANGE_ID,
    status: 'handed_over',
    summary: 'Change the greeting',
    baseCommit: BASE,
    approvedAt: '2026-11-07T10:00:00.000Z',
    approvedBy: 'Owner',
    files,
  }
}

function serve(detail: HandedOverChangeDetail | null, list: unknown[] = []) {
  const calls: string[] = []
  const impl = (async (url: string | URL | Request) => {
    const u = String(url)
    calls.push(u)
    if (u.endsWith('/ext/v1/proposals')) return json({ data: list })
    if (u.endsWith(`/ext/v1/proposals/${CHANGE_ID}`)) {
      return detail
        ? json({ data: detail })
        : json({ error: { code: 'not_found', message: 'No handed-over change' } }, 404)
    }
    throw new Error(`unexpected request ${u}`)
  }) as typeof fetch
  return { fetch: impl, calls }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'marcapony-proposals-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, '.dev.vars'), 'MARCAPONY_API_KEY=mpk_secret\n')
  writeFileSync(
    join(dir, 'marcapony.json'),
    JSON.stringify({ app: 'transfer-app', build: 'echo build', worker: 'dist/index.js' }),
  )
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const base = { cliEnv: 'local', env: {}, log: () => {}, useGit: false }

describe('marcapony app proposals list', () => {
  it('lists the handed-over changes', async () => {
    const row = { ...change([]), files: undefined, fileCount: 2 }
    const logs: string[] = []
    const { fetch } = serve(null, [row])
    const result = await runProposalsList({
      ...base,
      cwd: dir,
      fetchImpl: fetch,
      log: (m) => logs.push(m),
    })
    expect(result.proposals).toHaveLength(1)
    expect(logs.join('\n')).toContain(CHANGE_ID)
    expect(logs.join('\n')).toContain('approved by Owner')
  })

  it('refuses an unlinked project', async () => {
    rmSync(join(dir, 'marcapony.json'))
    const err = await runProposalsList({ ...base, cwd: dir }).catch((e: unknown) => e)
    expect((err as CliError).exitCode).toBe(EXIT.notLinked)
  })
})

describe('marcapony app proposals pull', () => {
  it('applies edits, creates and deletes to untouched files and keeps the base', async () => {
    writeBase(dir, ENV_ID, 'a'.repeat(40))
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const hi = "hello"\n')
    writeFileSync(join(dir, 'src', 'old.ts'), 'old\n')
    const { fetch } = serve(
      change([
        {
          path: 'src/app.ts',
          op: 'edit',
          baseContent: 'export const hi = "hello"\n',
          content: 'export const hi = "merhaba"\n',
        },
        { path: 'src/new.ts', op: 'create', baseContent: null, content: 'new\n' },
        { path: 'src/old.ts', op: 'delete', baseContent: 'old\n', content: null },
      ]),
    )
    const result = await runProposalPull({ ...base, cwd: dir, fetchImpl: fetch, id: CHANGE_ID })
    expect(result.status).toBe('merged')
    expect(result.files).toEqual([
      { path: 'src/app.ts', action: 'updated' },
      { path: 'src/new.ts', action: 'added' },
      { path: 'src/old.ts', action: 'deleted' },
    ])
    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toBe('export const hi = "merhaba"\n')
    expect(readFileSync(join(dir, 'src', 'new.ts'), 'utf8')).toBe('new\n')
    expect(existsSync(join(dir, 'src', 'old.ts'))).toBe(false)
    expect(readBase(dir, ENV_ID)?.base).toBe('a'.repeat(40))
  })

  it('merges into a file changed elsewhere since the base', async () => {
    writeFileSync(join(dir, 'src', 'app.ts'), 'a\nb\nc\nd\ne2\n')
    const { fetch } = serve(
      change([
        {
          path: 'src/app.ts',
          op: 'edit',
          baseContent: 'a\nb\nc\nd\ne\n',
          content: 'a2\nb\nc\nd\ne\n',
        },
      ]),
    )
    const result = await runProposalPull({ ...base, cwd: dir, fetchImpl: fetch, id: CHANGE_ID })
    expect(result.status).toBe('merged')
    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toBe('a2\nb\nc\nd\ne2\n')
  })

  it('leaves markers and lists the regions on a conflict', async () => {
    writeFileSync(join(dir, 'src', 'app.ts'), 'a\nmine\nc\n')
    const { fetch } = serve(
      change([
        { path: 'src/app.ts', op: 'edit', baseContent: 'a\nb\nc\n', content: 'a\nyours\nc\n' },
      ]),
    )
    const result = await runProposalPull({ ...base, cwd: dir, fetchImpl: fetch, id: CHANGE_ID })
    expect(result.status).toBe('conflicts')
    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toContain('>>>>>>> change 22222222')
    expect(result.conflicts).toEqual({
      proposalId: CHANGE_ID,
      files: [
        {
          path: 'src/app.ts',
          regions: [{ id: 0, base: 'b\n', ours: 'mine\n', theirs: 'yours\n' }],
        },
      ],
    })
  })

  it('lists a delete against a local edit as one whole-file region and leaves the file', async () => {
    writeFileSync(join(dir, 'src', 'app.ts'), 'changed\n')
    const { fetch } = serve(
      change([{ path: 'src/app.ts', op: 'delete', baseContent: 'original\n', content: null }]),
    )
    const result = await runProposalPull({ ...base, cwd: dir, fetchImpl: fetch, id: CHANGE_ID })
    expect(result.status).toBe('conflicts')
    expect(result.conflicts?.files).toEqual([
      {
        path: 'src/app.ts',
        regions: [{ id: 0, base: 'original\n', ours: 'changed\n', theirs: null }],
      },
    ])
    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toBe('changed\n')
  })

  it('reports files that already contain the change as unchanged', async () => {
    writeFileSync(join(dir, 'src', 'app.ts'), 'after\n')
    const { fetch } = serve(
      change([{ path: 'src/app.ts', op: 'edit', baseContent: 'before\n', content: 'after\n' }]),
    )
    const result = await runProposalPull({ ...base, cwd: dir, fetchImpl: fetch, id: CHANGE_ID })
    expect(result.files).toEqual([{ path: 'src/app.ts', action: 'unchanged' }])
  })

  it('asks before writing into a file with uncommitted changes, and --yes skips the question', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-qm',
        'init',
        '--allow-empty',
      ],
      { cwd: dir },
    )
    writeFileSync(join(dir, 'src', 'app.ts'), 'before\n')
    const detail = change([
      { path: 'src/app.ts', op: 'edit', baseContent: 'before\n', content: 'after\n' },
    ])
    const err = await runProposalPull({
      ...base,
      cwd: dir,
      fetchImpl: serve(detail).fetch,
      id: CHANGE_ID,
    }).catch((e: unknown) => e)
    expect((err as CliError).exitCode).toBe(EXIT.refused)
    expect((err as CliError).message).toContain(`marcapony app proposals pull ${CHANGE_ID} --yes`)
    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toBe('before\n')

    const result = await runProposalPull({
      ...base,
      cwd: dir,
      fetchImpl: serve(detail).fetch,
      id: CHANGE_ID,
      yes: true,
    })
    expect(result.status).toBe('merged')
    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toBe('after\n')
  })

  it('passes on the platform refusal for an unknown id', async () => {
    const { fetch } = serve(null)
    const err = await runProposalPull({ ...base, cwd: dir, fetchImpl: fetch, id: CHANGE_ID }).catch(
      (e: unknown) => e,
    )
    expect((err as CliError).exitCode).toBe(EXIT.refused)
  })

  it('needs an id', async () => {
    const err = await runProposalPull({ ...base, cwd: dir, id: undefined }).catch((e: unknown) => e)
    expect((err as CliError).exitCode).toBe(EXIT.failed)
  })
})

describe('readConflictRegions', () => {
  const labels = { ours: 'yours', base: 'base x', theirs: 'change y' }
  const whole = { base: 'B', ours: 'O', theirs: 'T' }

  it('reads two regions back from the markers', () => {
    const merged = [
      'top',
      '<<<<<<< yours',
      'o1',
      '||||||| base x',
      'b1',
      '=======',
      't1',
      '>>>>>>> change y',
      'mid',
      '<<<<<<< yours',
      '||||||| base x',
      'b2',
      '=======',
      't2',
      '>>>>>>> change y',
      '',
    ].join('\n')
    expect(readConflictRegions(merged, labels, 2, whole)).toEqual([
      { id: 0, base: 'b1\n', ours: 'o1\n', theirs: 't1\n' },
      { id: 1, base: 'b2\n', ours: '', theirs: 't2\n' },
    ])
  })

  it('falls back to the whole file when the markers do not add up', () => {
    const merged = ['<<<<<<< yours', 'o', '||||||| base x', 'b', '=======', 't', ''].join('\n')
    expect(readConflictRegions(merged, labels, 1, whole)).toEqual([{ id: 0, ...whole }])
    const one = [
      '<<<<<<< yours',
      'o',
      '||||||| base x',
      'b',
      '=======',
      't',
      '>>>>>>> change y',
    ].join('\n')
    expect(readConflictRegions(one, labels, 2, whole)).toEqual([{ id: 0, ...whole }])
  })
})
