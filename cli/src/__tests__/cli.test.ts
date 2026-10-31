import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, parseArgs } from '../index'
import { parseEnvLines, resolveApiRoot, upsertEnvLines } from '../config'
import { collectAssets, contentTypeFor, isIgnoredAsset, parseAssetsIgnore } from '../assets'
import { runLink } from '../link'
import { runDeploy } from '../deploy'
import {
  collectSourceFiles,
  MAX_SOURCE_BYTES,
  pushSource,
  scanForSecrets,
  SourceTooLargeError,
} from '../source'
import { renderAgents, upsertAgentsBlock, AGENTS_BEGIN, AGENTS_END } from '../agents'
import type { Capability } from '../api'

const CAP_FIXTURE: Capability = {
  id: 'reservations.create',
  scope: 'reservations:write',
  method: 'POST',
  path: '/reservations',
  summary: 'Create a reservation (booking).',
  sdk: 'mp.reservations.create(input, { idempotencyKey })',
  input: 'CreateReservationInput { customerName: string; customerEmail: string }',
  response: 'Reservation { id }',
  idempotent: true,
  requiresPlugin: null,
  notes: ['Pass a stable idempotencyKey so a retried create does not double-book.'],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeFetch(responses: Response[]): {
  fetch: typeof fetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = responses.shift()
    if (!next) throw new Error('unexpected extra request')
    return next
  }) as typeof fetch
  return { fetch: impl, calls }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'marcapony-cli-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parseArgs', () => {
  it('splits the command namespace from flags', () => {
    const { command, flags } = parseArgs(['app', 'deploy', '--cli-env', 'staging', '--help'])
    expect(command).toEqual(['app', 'deploy'])
    expect(flags['cli-env']).toBe('staging')
    expect(flags.help).toBe(true)
  })
})

describe('--version', () => {
  it('prints the version this package was published as', async () => {
    // The constant and package.json drifted once already (0.1.0 vs 0.1.4), and
    // the number a bug report quotes came from the constant.
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')) as {
      version: string
    }
    const printed: string[] = []
    const log = console.log
    console.log = (message: unknown): void => void printed.push(String(message))
    try {
      expect(await main(['--version'])).toBe(0)
    } finally {
      console.log = log
    }
    expect(printed).toEqual([pkg.version])
  })
})

describe('resolveApiRoot', () => {
  it('defaults to production and maps the known env names', () => {
    expect(resolveApiRoot()).toBe('https://api.marcapony.com')
    expect(resolveApiRoot('production')).toBe('https://api.marcapony.com')
    expect(resolveApiRoot('staging')).toBe('https://staging-api.marcapony.com')
    expect(resolveApiRoot('local')).toBe('http://localhost:4000')
  })

  it('rejects an unknown env name instead of accepting an arbitrary URL', () => {
    expect(() => resolveApiRoot('https://evil.example.com')).toThrow('Unknown environment')
    expect(() => resolveApiRoot('prod')).toThrow('Unknown environment')
  })
})

describe('upsertEnvLines', () => {
  it('replaces existing keys in place and preserves comments', () => {
    const out = upsertEnvLines('# comment\nOTHER=1\nMARCAPONY_API_KEY=old\n', {
      MARCAPONY_API_KEY: 'new',
    })
    expect(out).toContain('# comment')
    expect(out).toContain('OTHER=1')
    expect(out).toContain('MARCAPONY_API_KEY=new')
    expect(out).not.toContain('old')
  })

  it('appends missing keys', () => {
    const out = upsertEnvLines('OTHER=1', { MARCAPONY_API_KEY: 'k', MARCAPONY_API_URL: 'u' })
    const parsed = parseEnvLines(out)
    expect(parsed.OTHER).toBe('1')
    expect(parsed.MARCAPONY_API_KEY).toBe('k')
    expect(parsed.MARCAPONY_API_URL).toBe('u')
  })

  it('writes into an empty file', () => {
    expect(parseEnvLines(upsertEnvLines('', { A: 'b' })).A).toBe('b')
  })
})

describe('contentTypeFor', () => {
  it('maps common web extensions and falls back to octet-stream', () => {
    expect(contentTypeFor('index.html')).toBe('text/html')
    expect(contentTypeFor('app.js')).toBe('text/javascript')
    expect(contentTypeFor('logo.svg')).toBe('image/svg+xml')
    expect(contentTypeFor('weird.zzz')).toBe('application/octet-stream')
  })
})

describe('assets ignore', () => {
  it('parses .assetsignore, skipping comments and blanks', () => {
    expect(parseAssetsIgnore('# c\n\nwrangler.json\n.dev.vars\n./private/\n')).toEqual([
      'wrangler.json',
      '.dev.vars',
      'private',
    ])
  })

  it('never serves secrets or the ignore file itself, whatever the build emitted', () => {
    expect(isIgnoredAsset('/.dev.vars', [])).toBe(true)
    expect(isIgnoredAsset('/.assetsignore', [])).toBe(true)
    expect(isIgnoredAsset('/wrangler.json', [])).toBe(true)
    expect(isIgnoredAsset('/index.html', [])).toBe(false)
  })

  it('matches listed files and anything under a listed directory', () => {
    expect(isIgnoredAsset('/private/secret.txt', ['private'])).toBe(true)
    expect(isIgnoredAsset('/notes.txt', ['notes.txt'])).toBe(true)
    expect(isIgnoredAsset('/public/app.js', ['private'])).toBe(false)
  })

  it('excludes ignored files when walking a real directory', () => {
    mkdirSync(join(dir, 'assets', 'private'), { recursive: true })
    writeFileSync(join(dir, 'assets', 'index.html'), '<html></html>')
    writeFileSync(join(dir, 'assets', '.assetsignore'), 'wrangler.json\n.dev.vars\nprivate\n')
    writeFileSync(join(dir, 'assets', '.dev.vars'), 'MARCAPONY_API_KEY=mpk_leak')
    writeFileSync(join(dir, 'assets', 'private', 'notes.txt'), 'secret')

    const collected = collectAssets(join(dir, 'assets'))
    expect(collected.map((a) => a.path)).toEqual(['/index.html'])
  })
})

describe('runLink', () => {
  it('writes the key into .dev.vars and creates marcapony.json', async () => {
    writeFileSync(join(dir, '.dev.vars'), 'EXISTING=1\n')
    const { fetch: fetchImpl, calls } = makeFetch([
      jsonResponse({
        appSlug: 'transfer-app',
        environmentName: 'test',
        key: 'mpk_secret',
        baseUrl: 'http://localhost:4000/ext/v1',
      }),
      jsonResponse({ data: [CAP_FIXTURE] }),
    ])

    await runLink({
      cwd: dir,
      code: 'mpl_code',
      cliEnv: 'local',
      env: {},
      fetchImpl,
      log: () => {},
    })

    expect(calls[0]?.url).toBe('http://localhost:4000/apps/link')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: 'mpl_code' })
    expect(calls[1]?.url).toBe('http://localhost:4000/ext/v1/capabilities')

    const env = parseEnvLines(readFileSync(join(dir, '.dev.vars'), 'utf8'))
    expect(env.MARCAPONY_API_KEY).toBe('mpk_secret')
    expect(env.MARCAPONY_API_URL).toBe('http://localhost:4000/ext/v1')
    expect(env.EXISTING).toBe('1')

    const config = JSON.parse(readFileSync(join(dir, 'marcapony.json'), 'utf8'))
    expect(config.app).toBe('transfer-app')
    expect(config.build).toBe('bun run build')
    expect(config.worker).toBe('dist/index.js')

    // AGENTS.md is written with the app's scope-filtered operations.
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('# Marcapony integration — transfer-app')
    expect(agents).toContain('reservations.create')
    expect(agents).toContain('mp.reservations.create(input, { idempotencyKey })')
    // The secret key must never leak into AGENTS.md.
    expect(agents).not.toContain('mpk_secret')
  })

  it('keeps placement and permissions from an existing marcapony.json', async () => {
    const permissions = [{ id: 'view', label: 'View', grants: ['reservations.own.read'] }]
    writeFileSync(
      join(dir, 'marcapony.json'),
      JSON.stringify({
        build: 'bun run build',
        worker: 'dist/w.js',
        placement: 'portal',
        permissions,
      }),
    )
    const { fetch: fetchImpl } = makeFetch([
      jsonResponse({
        appSlug: 'transfer-app',
        environmentName: 'test',
        key: 'mpk_secret',
        baseUrl: 'http://localhost:4000/ext/v1',
      }),
      jsonResponse({ data: [CAP_FIXTURE] }),
    ])

    await runLink({
      cwd: dir,
      code: 'mpl_code',
      cliEnv: 'local',
      env: {},
      fetchImpl,
      log: () => {},
    })

    const config = JSON.parse(readFileSync(join(dir, 'marcapony.json'), 'utf8'))
    expect(config.app).toBe('transfer-app')
    expect(config.worker).toBe('dist/w.js')
    expect(config.placement).toBe('portal')
    expect(config.permissions).toEqual(permissions)
  })

  // .dev.vars holds a live key with the app's data scopes plus apps:deploy;
  // linking inside a project that never ignored it would publish the tenant's
  // credential on the next commit.
  it('ignores .dev.vars before writing the key', async () => {
    const { fetch: fetchImpl } = makeFetch([
      jsonResponse({
        appSlug: 'transfer-app',
        environmentName: 'test',
        key: 'mpk_secret',
        baseUrl: 'http://localhost:4000/ext/v1',
      }),
      jsonResponse({ data: [CAP_FIXTURE] }),
    ])

    await runLink({
      cwd: dir,
      code: 'mpl_code',
      cliEnv: 'local',
      env: {},
      fetchImpl,
      log: () => {},
    })

    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.dev.vars')
  })

  it('does not duplicate an existing .dev.vars ignore entry', async () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n.dev.vars\n')
    const { fetch: fetchImpl } = makeFetch([
      jsonResponse({
        appSlug: 'transfer-app',
        environmentName: 'test',
        key: 'mpk_secret',
        baseUrl: 'http://localhost:4000/ext/v1',
      }),
      jsonResponse({ data: [CAP_FIXTURE] }),
    ])

    await runLink({
      cwd: dir,
      code: 'mpl_code',
      cliEnv: 'local',
      env: {},
      fetchImpl,
      log: () => {},
    })

    const ignore = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(ignore.match(/^\.dev\.vars$/gm)?.length).toBe(1)
  })

  it('does not fail the link when the capabilities fetch errors', async () => {
    const { fetch: fetchImpl } = makeFetch([
      jsonResponse({
        appSlug: 'transfer-app',
        environmentName: 'test',
        key: 'mpk_secret',
        baseUrl: 'http://localhost:4000/ext/v1',
      }),
      jsonResponse({ error: { code: 'server_error', message: 'nope' } }, 500),
    ])

    await runLink({
      cwd: dir,
      code: 'mpl_code',
      cliEnv: 'local',
      env: {},
      fetchImpl,
      log: () => {},
    })

    // The key + config still landed; AGENTS.md is simply skipped.
    expect(parseEnvLines(readFileSync(join(dir, '.dev.vars'), 'utf8')).MARCAPONY_API_KEY).toBe(
      'mpk_secret',
    )
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false)
  })

  it('prompts for the code when none is passed and keeps an existing config', async () => {
    writeFileSync(
      join(dir, 'marcapony.json'),
      JSON.stringify({ app: 'keep-me', build: 'npm run build', worker: 'out/worker.js' }),
    )
    const { fetch: fetchImpl } = makeFetch([
      jsonResponse({
        appSlug: 'transfer-app',
        environmentName: 'test',
        key: 'mpk_secret',
        baseUrl: 'http://localhost:4000/ext/v1',
      }),
    ])

    await runLink({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl,
      prompt: async () => 'mpl_prompted',
      log: () => {},
    })

    const config = JSON.parse(readFileSync(join(dir, 'marcapony.json'), 'utf8'))
    expect(config.app).toBe('keep-me')
    expect(config.worker).toBe('out/worker.js')
  })

  it('surfaces the generic exchange failure', async () => {
    const { fetch: fetchImpl } = makeFetch([
      jsonResponse({ error: 'Invalid or expired pairing code' }, 400),
    ])
    await expect(
      runLink({ cwd: dir, code: 'bad', env: {}, fetchImpl, log: () => {} }),
    ).rejects.toThrow('Invalid or expired pairing code')
  })
})

describe('runDeploy', () => {
  function scaffold(config: Record<string, unknown> = {}): void {
    mkdirSync(join(dir, 'dist', 'client'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'index.js'), 'export default {}')
    writeFileSync(join(dir, 'dist', 'client', 'index.html'), '<html></html>')
    writeFileSync(join(dir, '.dev.vars'), 'MARCAPONY_API_KEY=mpk_secret\n')
    writeFileSync(
      join(dir, 'marcapony.json'),
      JSON.stringify({
        app: 'transfer-app',
        build: 'echo build',
        worker: 'dist/index.js',
        assets: 'dist/client',
        ...config,
      }),
    )
  }

  it('builds, uploads the worker + assets, and reports the live hostname', async () => {
    scaffold()
    const { fetch: fetchImpl, calls } = makeFetch([
      jsonResponse(
        {
          data: {
            id: 'dep-1',
            status: 'live',
            hostname: 'transfer-app--acme.staging.marcapony.com',
            error: null,
          },
        },
        201,
      ),
    ])
    const built: string[] = []

    const result = await runDeploy({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl,
      runBuild: (cmd) => built.push(cmd),
      log: () => {},
    })

    expect(built).toEqual(['echo build'])
    expect(result.hostname).toBe('transfer-app--acme.staging.marcapony.com')
    expect(calls[0]?.url).toBe('http://localhost:4000/ext/v1/deployments')

    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer mpk_secret')

    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.worker.encoding).toBe('base64')
    expect(Buffer.from(body.worker.content, 'base64').toString()).toBe('export default {}')
    expect(body.assets).toHaveLength(1)
    expect(body.assets[0].path).toBe('/index.html')
    expect(body.assets[0].contentType).toBe('text/html')
    // Stateless rule: the CLI never sends bindings.
    expect(body.bindings).toBeUndefined()
  })

  it('sends placement and permissions from marcapony.json, and nothing when they are absent', async () => {
    scaffold({
      placement: 'portal',
      permissions: [
        { id: 'view', label: 'View', grants: ['reservations.own.read'] },
        { id: 'approve', label: 'Approve' },
      ],
      portal: { title: 'Bookings', icon: 'calendar', sortOrder: 2 },
    })
    const live = () =>
      jsonResponse({ data: { id: 'dep-1', status: 'live', hostname: null, error: null } }, 201)
    const first = makeFetch([live()])
    await runDeploy({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: first.fetch,
      runBuild: () => {},
      log: () => {},
    })
    const body = JSON.parse(String(first.calls[0]?.init.body))
    expect(body.placement).toBe('portal')
    expect(body.permissions).toEqual([
      { id: 'view', label: 'View', grants: ['reservations.own.read'] },
      { id: 'approve', label: 'Approve', grants: [] },
    ])
    expect(body.portal).toEqual({ title: 'Bookings', icon: 'calendar', sortOrder: 2 })

    scaffold()
    const second = makeFetch([live()])
    await runDeploy({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: second.fetch,
      runBuild: () => {},
      log: () => {},
    })
    const plain = JSON.parse(String(second.calls[0]?.init.body))
    expect(plain.placement).toBeUndefined()
    expect(plain.permissions).toBeUndefined()
    expect(plain.portal).toBeUndefined()
  })

  it('polls while the deployment is still uploading', async () => {
    scaffold()
    const { fetch: fetchImpl, calls } = makeFetch([
      jsonResponse(
        { data: { id: 'dep-1', status: 'uploading', hostname: null, error: null } },
        201,
      ),
      jsonResponse({
        data: { id: 'dep-1', status: 'live', hostname: 'a--b.staging.marcapony.com', error: null },
      }),
    ])

    const result = await runDeploy({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl,
      runBuild: () => {},
      sleep: async () => {},
      log: () => {},
    })

    expect(result.status).toBe('live')
    expect(calls[1]?.url).toBe('http://localhost:4000/ext/v1/deployments/dep-1')
  })

  it('throws with the surfaced cause when the deploy failed', async () => {
    scaffold()
    const { fetch: fetchImpl } = makeFetch([
      jsonResponse(
        {
          data: {
            id: 'dep-1',
            status: 'failed',
            hostname: null,
            error: 'script-upload: bad module',
          },
        },
        201,
      ),
    ])

    await expect(
      runDeploy({
        cwd: dir,
        cliEnv: 'local',
        env: {},
        fetchImpl,
        runBuild: () => {},
        log: () => {},
      }),
    ).rejects.toThrow('script-upload: bad module')
  })

  it('refuses to deploy without a linked project', async () => {
    await expect(
      runDeploy({ cwd: dir, env: {}, runBuild: () => {}, log: () => {} }),
    ).rejects.toThrow('marcapony app link')
  })

  it('refuses to deploy without a key', async () => {
    scaffold()
    writeFileSync(join(dir, '.dev.vars'), 'OTHER=1\n')
    await expect(
      runDeploy({ cwd: dir, env: {}, runBuild: () => {}, log: () => {} }),
    ).rejects.toThrow('MARCAPONY_API_KEY')
  })
})

describe('renderAgents', () => {
  it('documents each capability with its sdk call, schemas and notes', () => {
    const md = renderAgents({ appName: 'transfer-app', capabilities: [CAP_FIXTURE] })
    expect(md.startsWith(AGENTS_BEGIN)).toBe(true)
    expect(md.trimEnd().endsWith(AGENTS_END)).toBe(true)
    expect(md).toContain('# Marcapony integration — transfer-app')
    expect(md).toContain('### reservations.create — Create a reservation (booking).')
    expect(md).toContain('`POST /reservations` · scope `reservations:write`')
    expect(md).toContain('mp.reservations.create(input, { idempotencyKey })')
    expect(md).toContain('- Input: `CreateReservationInput')
    expect(md).toContain('- Returns: `Reservation')
    expect(md).toContain('double-book')
    expect(md).toContain('npx marcapony app deploy')
  })

  it('notes the plugin requirement when present', () => {
    const md = renderAgents({
      appName: 'x',
      capabilities: [{ ...CAP_FIXTURE, id: 'orders.create', requiresPlugin: 'ecommerce' }],
    })
    expect(md).toContain('requires the `ecommerce` plugin')
  })

  it('handles an empty capability list', () => {
    const md = renderAgents({ appName: 'x', capabilities: [] })
    expect(md).toContain('No operations are listed')
  })
})

describe('upsertAgentsBlock', () => {
  const block = `${AGENTS_BEGIN}\nHELLO\n${AGENTS_END}`

  it('creates the block in an empty file', () => {
    expect(upsertAgentsBlock('', block)).toBe(`${block}\n`)
  })

  it('appends after existing content, preserving it', () => {
    const out = upsertAgentsBlock('# My notes\n', block)
    expect(out).toContain('# My notes')
    expect(out).toContain('HELLO')
  })

  it('replaces the block in place, keeping surrounding content', () => {
    const before = `top\n\n${AGENTS_BEGIN}\nOLD\n${AGENTS_END}\n\nbottom\n`
    const out = upsertAgentsBlock(before, block)
    expect(out).toContain('top')
    expect(out).toContain('bottom')
    expect(out).toContain('HELLO')
    expect(out).not.toContain('OLD')
  })
})

describe('source push (spike)', () => {
  function scaffold(): void {
    mkdirSync(join(dir, 'dist', 'client'), { recursive: true })
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'index.js'), 'export default {}')
    writeFileSync(join(dir, 'dist', 'client', 'index.html'), '<html></html>')
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const a = 1\n')
    writeFileSync(join(dir, 'src', 'big.log'), 'noise')
    writeFileSync(join(dir, 'node_modules', 'x', 'i.js'), '1')
    writeFileSync(join(dir, '.dev.vars'), 'MARCAPONY_API_KEY=mpk_secret\n')
    writeFileSync(join(dir, '.gitignore'), '*.log\n')
    writeFileSync(join(dir, 'package.json'), '{}')
    writeFileSync(
      join(dir, 'marcapony.json'),
      JSON.stringify({
        app: 'transfer-app',
        build: 'echo build',
        worker: 'dist/index.js',
        assets: 'dist/client',
      }),
    )
  }

  const GRANT = {
    repoName: 'app-1',
    remote: 'https://acc.artifacts.cloudflare.net/git/ns/app-1.git',
    branch: 'test',
    token: 'art_v1_abc?expires=1',
    expiresAt: null,
  }
  const live = (): Response =>
    jsonResponse(
      { data: { id: 'dep-1', status: 'live', hostname: 'a.example.com', error: null } },
      201,
    )

  it('collects source honouring built-in excludes, build outputs and .gitignore', () => {
    scaffold()
    const files = collectSourceFiles(dir, { worker: 'dist/index.js', assets: 'dist/client' })
    expect(files).toEqual(['.gitignore', 'marcapony.json', 'package.json', 'src/app.ts'])
  })

  it('stops at the file and size caps', () => {
    scaffold()
    writeFileSync(join(dir, 'huge.bin'), Buffer.alloc(MAX_SOURCE_BYTES + 1))
    expect(() => collectSourceFiles(dir, { worker: 'dist/index.js' })).toThrow(SourceTooLargeError)
  })

  it('finds known key formats without returning the value', () => {
    scaffold()
    writeFileSync(join(dir, 'src', 'leak.ts'), 'const k = "mpk_abcdefghijklmnop1234"\n')
    const findings = scanForSecrets(dir, ['src/app.ts', 'src/leak.ts'])
    expect(findings).toEqual([{ path: 'src/leak.ts', line: 1, rule: 'Marcapony API key' }])
  })

  it('does nothing extra unless MARCAPONY_SOURCE_PUSH=1', async () => {
    scaffold()
    const { fetch: fetchImpl, calls } = makeFetch([live()])
    await runDeploy({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl,
      runBuild: () => {},
      log: () => {},
    })
    expect(calls).toHaveLength(1)
  })

  it('pushes the source with the granted token when enabled', async () => {
    scaffold()
    const { fetch: fetchImpl, calls } = makeFetch([jsonResponse({ data: GRANT }, 201), live()])
    const pushed: Array<{ files: string[]; branch: string }> = []
    await runDeploy({
      cwd: dir,
      cliEnv: 'local',
      env: { MARCAPONY_SOURCE_PUSH: '1' },
      fetchImpl,
      runBuild: () => {},
      log: () => {},
      pushSourceImpl: async (o) => {
        pushed.push({ files: o.files, branch: o.grant.branch })
        return 'oid'
      },
    })
    expect(calls[0]?.url).toContain('/ext/v1/deployments/source-token')
    expect(pushed).toEqual([
      { files: ['.gitignore', 'marcapony.json', 'package.json', 'src/app.ts'], branch: 'test' },
    ])
  })

  it('never reads credential files, whatever the ignore rules say', () => {
    scaffold()
    for (const name of ['.dev.vars.production', '.npmrc', '.netrc', 'id_ed25519', 'cert.p12']) {
      writeFileSync(join(dir, name), 'secret')
    }
    const files = collectSourceFiles(dir, { worker: 'dist/index.js', assets: 'dist/client' })
    expect(files).toEqual(['.gitignore', 'marcapony.json', 'package.json', 'src/app.ts'])
  })

  it('does not push, or even ask for a token, when no source file is left', async () => {
    scaffold()
    // An allowlist .gitignore: its negations are skipped, so `*` drops everything.
    writeFileSync(join(dir, '.gitignore'), '*\n!src/\n')
    const { fetch: fetchImpl, calls } = makeFetch([live()])
    const logs: string[] = []
    let pushed = false
    await runDeploy({
      cwd: dir,
      cliEnv: 'local',
      env: { MARCAPONY_SOURCE_PUSH: '1' },
      fetchImpl,
      runBuild: () => {},
      log: (m) => logs.push(m),
      pushSourceImpl: async () => {
        pushed = true
        return 'oid'
      },
    })
    expect(pushed).toBe(false)
    expect(calls.some((c) => c.url.includes('source-token'))).toBe(false)
    expect(logs.some((l) => l.includes('no files left'))).toBe(true)
  })

  it('warns and still deploys when the push fails', async () => {
    scaffold()
    const { fetch: fetchImpl } = makeFetch([jsonResponse({ data: GRANT }, 201), live()])
    const logs: string[] = []
    const result = await runDeploy({
      cwd: dir,
      cliEnv: 'local',
      env: { MARCAPONY_SOURCE_PUSH: '1' },
      fetchImpl,
      runBuild: () => {},
      log: (m) => logs.push(m),
      pushSourceImpl: async () => {
        throw new Error('network down')
      },
    })
    expect(result.status).toBe('live')
    expect(logs.some((m) => m.includes('Warning: source not saved (network down)'))).toBe(true)
  })

  it('skips the push quietly when the platform has source storage off', async () => {
    scaffold()
    const { fetch: fetchImpl } = makeFetch([
      jsonResponse({ error: { code: 'server_error' } }, 503),
      live(),
    ])
    let called = false
    const result = await runDeploy({
      cwd: dir,
      cliEnv: 'local',
      env: { MARCAPONY_SOURCE_PUSH: '1' },
      fetchImpl,
      runBuild: () => {},
      log: () => {},
      pushSourceImpl: async () => {
        called = true
        return 'oid'
      },
    })
    expect(result.status).toBe('live')
    expect(called).toBe(false)
  })

  it('skips the push and warns when the secret scan finds a key', async () => {
    scaffold()
    writeFileSync(join(dir, 'src', 'leak.ts'), 'const k = "sk_live_abcdefghijklmnop1234"\n')
    const { fetch: fetchImpl, calls } = makeFetch([live()])
    const logs: string[] = []
    await runDeploy({
      cwd: dir,
      cliEnv: 'local',
      env: { MARCAPONY_SOURCE_PUSH: '1' },
      fetchImpl,
      runBuild: () => {},
      log: (m) => logs.push(m),
    })
    expect(calls).toHaveLength(1)
    expect(logs.join('\n')).toContain('Stripe-style secret key in src/leak.ts:1')
    expect(logs.join('\n')).not.toContain('sk_live_abc')
  })

  it('configures origin before fetching, so the commit can build on the remote branch', async () => {
    scaffold()
    const git = (await import('isomorphic-git')).default
    const seen: Array<{ url: unknown; refspec: unknown }> = []
    await pushSource({
      cwd: dir,
      files: ['package.json'],
      grant: GRANT,
      fetch: (async (o: { fs: never; gitdir: string }) => {
        seen.push({
          url: await git.getConfig({ fs: o.fs, gitdir: o.gitdir, path: 'remote.origin.url' }),
          refspec: await git.getConfig({ fs: o.fs, gitdir: o.gitdir, path: 'remote.origin.fetch' }),
        })
        throw new Error('empty remote')
      }) as never,
      push: (async () => ({ ok: true, error: null, refs: {} })) as never,
    })
    expect(seen).toEqual([{ url: GRANT.remote, refspec: '+refs/heads/*:refs/remotes/origin/*' }])
  })

  it('commits locally in a temp gitdir and pushes on top of the remote branch', async () => {
    scaffold()
    const pushes: Array<Record<string, unknown>> = []
    const oid = await pushSource({
      cwd: dir,
      files: ['src/app.ts', 'package.json'],
      grant: GRANT,
      message: 'first',
      fetch: (async () => {
        throw new Error('empty remote')
      }) as never,
      push: (async (o: Record<string, unknown>) => {
        pushes.push(o)
        return { ok: true, error: null, refs: {} }
      }) as never,
    })
    expect(oid).toMatch(/^[0-9a-f]{40}$/)
    expect(pushes).toHaveLength(1)
    const auth = (pushes[0]!.onAuth as () => { username: string; password: string })()
    expect(auth).toEqual({ username: 'x', password: 'art_v1_abc' })
    expect(pushes[0]!.ref).toBe('test')
    expect(existsSync(join(dir, '.git'))).toBe(false)
  })
})
