import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CliError } from '../api'
import { collectionPlacementProblem, collectionProblems } from '../collections'
import { runDeployDetailed } from '../deploy'
import { readFileSync } from 'node:fs'

interface CollectionRule {
  case: string
  input: unknown[]
  ok: boolean
  dataAccess?: string
}

// The platform's own cases for the collection rules, kept in step with it.
const rules = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'collection-rules.json'), 'utf8'),
) as { schema: CollectionRule[]; dataAccess: CollectionRule[] }

describe('the collection rules fixture', () => {
  for (const rule of rules.schema) {
    it(`schema: ${rule.case}`, () => {
      expect(collectionProblems(rule.input).length === 0).toBe(rule.ok)
    })
  }
  for (const rule of rules.dataAccess) {
    it(`data access: ${rule.case}`, () => {
      const problem = collectionPlacementProblem({
        collections: rule.input,
        dataAccess: rule.dataAccess,
      })
      expect(collectionProblems(rule.input)).toEqual([])
      expect(problem === null).toBe(rule.ok)
    })
  }
})

const ENTRIES = {
  name: 'entries',
  read: 'own',
  write: 'own',
  maxRows: 2000,
  indexes: [
    { field: 'status', type: 'string' },
    { field: 'loggedAt', type: 'date' },
  ],
}

describe('collectionProblems', () => {
  it('accepts a valid list, an empty list and an absent field', () => {
    expect(collectionProblems([ENTRIES, { name: 'prefs', read: 'own', write: 'own' }])).toEqual([])
    expect(collectionProblems([])).toEqual([])
    expect(collectionProblems(undefined)).toEqual([])
  })

  it('reports every problem with where it is', () => {
    const problems = collectionProblems([
      { name: 'Entries', read: 'own', write: 'all', maxRows: 0, color: 'red' },
      {
        name: 'logs',
        read: 'own',
        write: 'own',
        indexes: [
          { field: 'a.b', type: 'string' },
          { field: 'at', type: 'timestamp' },
          { field: 'at', type: 'date', unique: true },
        ],
      },
      { name: 'logs', read: 'own', write: 'own' },
    ])
    expect(problems).toEqual([
      'collections[0].color is not a known field',
      'collections[0].name must be lower case letters, digits and underscores, starting with a letter (at most 48)',
      'collections[0].write must be "own" on a customer collection',
      'collections[0].maxRows must be a whole number from 1 to 10000',
      'collections[1].indexes[0].field must be a top-level key of the record: letters, digits and underscores, starting with a letter',
      'collections[1].indexes[1].type must be one of string, number, date, boolean',
      'collections[1].indexes[2].unique is not a known field',
      'collections[1].indexes[2].field "at" is duplicated',
      'collections[2].name "logs" is duplicated',
    ])
  })

  it('refuses a value that is not a list, too many collections and too many indexes', () => {
    expect(collectionProblems({ entries: {} })).toEqual(['collections must be a list'])
    const many = Array.from({ length: 17 }, (_, i) => ({
      name: `c${i}`,
      read: 'own',
      write: 'own',
    }))
    expect(collectionProblems(many)).toEqual(['collections has more than 16 entries'])
    const indexes = ['a', 'b', 'c', 'd', 'e'].map((field) => ({ field, type: 'number' }))
    expect(collectionProblems([{ ...ENTRIES, indexes }])).toEqual([
      'collections[0].indexes has more than 4 entries',
    ])
  })
})

describe('collectionPlacementProblem', () => {
  it('only objects to a data access the file states', () => {
    expect(
      collectionPlacementProblem({ collections: [ENTRIES], dataAccess: 'customer' }),
    ).toBeNull()
    expect(collectionPlacementProblem({ collections: [ENTRIES] })).toBeNull()
    expect(collectionPlacementProblem({ collections: [], dataAccess: 'team' })).toBeNull()
    expect(collectionPlacementProblem({ collections: [ENTRIES], dataAccess: 'team' })).toContain(
      '"dataAccess": "customer"',
    )
  })
})

describe('deploying collections', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mp-collections-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function write(file: string, content: string): void {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), content)
  }

  function project(config: Record<string, unknown>): void {
    write('marcapony.json', JSON.stringify({ app: 'journal', build: 'echo build', ...config }))
    write('.env.local', 'MARCAPONY_API_KEY=mpk_x\n')
    write('dist/server/index.js', 'export default {}')
  }

  function recorder() {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (init?.method === 'POST') posts.push({ url: u, body: JSON.parse(String(init.body)) })
      if (u.endsWith('/source-head')) {
        return new Response('{"error":{"code":"not_found","message":"x"}}', { status: 404 })
      }
      if (u.endsWith('/validate')) return new Response('{"data":{"ok":true}}', { status: 200 })
      return new Response(
        JSON.stringify({ data: { id: 'd', status: 'live', hostname: null, error: null } }),
        { status: 201 },
      )
    }) as typeof fetch
    return { posts, fetchImpl }
  }

  const deploy = (fetchImpl: typeof fetch) =>
    runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      source: false,
      fetchImpl,
      runBuild: () => {},
      log: () => {},
    })

  it('sends them inside a version 2 manifest, to the check and to the deploy', async () => {
    project({ manifest: 2, dataAccess: 'customer', collections: [ENTRIES] })
    const { posts, fetchImpl } = recorder()
    await deploy(fetchImpl)
    expect(posts).toHaveLength(2)
    for (const post of posts) {
      expect((post.body.manifest as { collections: unknown }).collections).toEqual([ENTRIES])
      expect(post.body.collections).toBeUndefined()
    }
  })

  it('sends them as a field for a version 1 file, and nothing when the file has none', async () => {
    project({ worker: 'dist/server/index.js', collections: [ENTRIES] })
    const first = recorder()
    await deploy(first.fetchImpl)
    expect(first.posts.map((post) => post.body.collections)).toEqual([[ENTRIES], [ENTRIES]])

    project({ worker: 'dist/server/index.js' })
    const second = recorder()
    await deploy(second.fetchImpl)
    expect(second.posts.every((post) => !('collections' in post.body))).toBe(true)
  })

  it('stops before the build and before any request when the declaration is wrong', async () => {
    project({
      manifest: 2,
      dataAccess: 'team',
      collections: [{ name: 'entries', read: 'everyone', write: 'own' }],
    })
    const { posts, fetchImpl } = recorder()
    let built = false
    const failure = await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      source: false,
      fetchImpl,
      runBuild: () => {
        built = true
      },
      log: () => {},
    }).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(CliError)
    expect((failure as CliError).message).toContain('collections[0].read must be "own"')
    expect((failure as CliError).message).toContain('"dataAccess": "customer"')
    expect(built).toBe(false)
    expect(posts).toHaveLength(0)
  })
})
