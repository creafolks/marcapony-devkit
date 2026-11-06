import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectAssets } from '../assets'
import { resolveApiKey, type MarcaponyConfig } from '../config'
import { runDeployDetailed } from '../deploy'
import { runMigrateConfig } from '../migrate'
import { planSourceFiles } from '../source'

// Manifest version 2: the CLI sends it as written, the platform translates it.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'marcapony-v2-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const V2: MarcaponyConfig = {
  manifest: 2,
  app: 'booking',
  build: 'echo build',
  server: 'dist/server/index.js',
  public: { dir: 'dist/client', ignore: ['secret.txt'] },
  routes: { server: ['/api/*'], notFound: 'spa' },
  runtime: '2026-10',
  ignore: ['coverage/', '*.log', '!keep.log'],
  placement: 'portal',
}

function write(path: string, content = 'x'): void {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), content)
}

describe('source ignore rules', () => {
  it('applies .gitignore, then the manifest, where ! re-includes; nothing re-includes the built-in list', () => {
    write('.gitignore', 'generated.ts\n')
    write('src/app.ts')
    write('generated.ts')
    write('debug.log')
    write('keep.log')
    write('coverage/index.html')
    write('.env.local', 'MARCAPONY_API_KEY=mpk_x')
    write('node_modules/x/i.js')
    const config: MarcaponyConfig = {
      ...V2,
      ignore: [...(V2.ignore ?? []), '!generated.ts', '!.env.local'],
    }
    const plan = planSourceFiles(dir, config, true)
    expect(plan.files).toEqual(['.gitignore', 'generated.ts', 'keep.log', 'src/app.ts'])
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.path, s.reason]))
    expect(reasons['debug.log']).toBe('*.log (marcapony.json ignore)')
    expect(reasons['coverage/']).toBe('coverage/ (marcapony.json ignore)')
    expect(reasons['.env.local']).toBe('built-in')
    expect(reasons['node_modules/']).toBe('built-in')
  })

  it('honours a nested .gitignore only below its directory', () => {
    write('src/.gitignore', 'local.ts\n')
    write('src/local.ts')
    write('local.ts')
    const plan = planSourceFiles(dir, { ...V2, ignore: [] }, true)
    expect(plan.files).toContain('local.ts')
    expect(plan.files).not.toContain('src/local.ts')
    expect(plan.skipped.find((s) => s.path === 'src/local.ts')?.reason).toBe(
      'local.ts (src/.gitignore)',
    )
  })

  it('reads .git/info/exclude', () => {
    write('.git/info/exclude', 'notes.md\n')
    write('notes.md')
    write('README.md')
    expect(planSourceFiles(dir, { ...V2, ignore: [] }).files).toEqual(['README.md'])
  })

  it('skips the build outputs the manifest names', () => {
    write('dist/server/index.js')
    write('dist/client/index.html')
    write('src/app.ts')
    expect(planSourceFiles(dir, V2).files).toEqual(['src/app.ts'])
  })
})

describe('public files', () => {
  it('uses public.ignore instead of .assetsignore', () => {
    write('dist/client/index.html')
    write('dist/client/secret.txt')
    write('dist/client/.assetsignore', 'index.html\n')
    const paths = collectAssets(join(dir, 'dist/client'), ['secret.txt']).map((a) => a.path)
    expect(paths).toEqual(['/index.html'])
  })
})

describe('the key file', () => {
  it('reads .env.local first and .dev.vars as a fallback', () => {
    write('.dev.vars', 'MARCAPONY_API_KEY=mpk_old\n')
    expect(resolveApiKey(dir, {})).toBe('mpk_old')
    write('.env.local', 'MARCAPONY_API_KEY=mpk_new\n')
    expect(resolveApiKey(dir, {})).toBe('mpk_new')
  })
})

describe('deploying a version 2 project', () => {
  it('sends the manifest as written and none of the runtime fields', async () => {
    write('marcapony.json', JSON.stringify({ $schema: './x.json', ...V2 }))
    write('.env.local', 'MARCAPONY_API_KEY=mpk_x\n')
    write('dist/server/index.js', 'export default {}')
    write('dist/client/index.html', '<html></html>')
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/source-head') || u.endsWith('/validate')) {
        return new Response('{"error":{"code":"not_found","message":"x"}}', { status: 404 })
      }
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(
        JSON.stringify({
          data: {
            id: 'd',
            status: 'live',
            hostname: null,
            error: null,
            warnings: ['IYZICO is required'],
          },
        }),
        { status: 201 },
      )
    }) as typeof fetch
    const logs: string[] = []
    await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      source: false,
      fetchImpl,
      runBuild: () => {},
      log: (m) => logs.push(m),
    })
    const body = bodies[0]!
    expect(body.manifest).toEqual(V2)
    expect(body.compatibilityDate).toBeUndefined()
    expect(body.assetsConfig).toBeUndefined()
    expect(body.placement).toBeUndefined()
    expect((body.assets as unknown[]).length).toBe(1)
    expect(logs).toContain('Warning: IYZICO is required')
  })
})

describe('marcapony app migrate-config', () => {
  it('rewrites a version 1 file and says what changed', () => {
    write(
      'marcapony.json',
      JSON.stringify({
        app: 'booking',
        build: 'bun run build',
        worker: 'dist/worker/index.js',
        assets: 'dist/client',
        assetsConfig: {
          not_found_handling: 'single-page-application',
          run_worker_first: ['/api/*'],
        },
        compatibilityDate: '2026-10-01',
        compatibilityFlags: ['nodejs_compat'],
        placement: 'portal',
      }),
    )
    write('.marcaponyignore', '*.psd\n')
    write('dist/client/.assetsignore', 'stats.html\n')
    const logs: string[] = []
    const result = runMigrateConfig({ cwd: dir, log: (m) => logs.push(m) })
    const written = JSON.parse(readFileSync(join(dir, 'marcapony.json'), 'utf8'))
    expect(written).toEqual({
      $schema: './node_modules/marcapony/manifest.schema.json',
      manifest: 2,
      app: 'booking',
      build: 'bun run build',
      placement: 'portal',
      server: 'dist/worker/index.js',
      public: { dir: 'dist/client', ignore: ['stats.html'] },
      routes: { notFound: 'spa', server: ['/api/*'] },
      runtime: '2026-10',
      ignore: ['*.psd'],
    })
    expect(result.changes.length).toBeGreaterThan(3)
    expect(logs[0]).toContain('version 2')
  })

  it('keeps an older runtime date on the oldest runtime', () => {
    write(
      'marcapony.json',
      JSON.stringify({ app: 'a', build: 'b', worker: 'w.js', compatibilityDate: '2025-05-10' }),
    )
    const result = runMigrateConfig({ cwd: dir, log: () => {} })
    expect(JSON.parse(readFileSync(join(dir, 'marcapony.json'), 'utf8')).runtime).toBe('2025-05')
    expect(result.notes.some((n) => n.startsWith('Runtime date changes'))).toBe(false)
  })

  it('says when the runtime date changes', () => {
    write(
      'marcapony.json',
      JSON.stringify({ app: 'a', build: 'b', worker: 'w.js', compatibilityDate: '2026-03-01' }),
    )
    const result = runMigrateConfig({ cwd: dir, log: () => {} })
    expect(result.notes).toContain(
      'Runtime date changes from 2026-03-01 to 2025-05-10 (runtime 2025-05). Test the app before deploying it.',
    )
  })
})
