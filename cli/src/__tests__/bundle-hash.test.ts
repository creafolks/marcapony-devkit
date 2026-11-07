import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleHashOf, runDeployDetailed } from '../deploy'
import { commitMessage, type PushSourceOptions } from '../source'

// The source commit of a CLI deploy names the bundle it went out with, so the
// platform can check that a released version's commit and bundle belong
// together. The hash must match the platform's: module bytes, then public
// files in upload order, as one stream.

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe('bundleHashOf', () => {
  it('hashes the module, then each public file in order, as one stream', () => {
    const worker = new TextEncoder().encode('export default {}')
    const a = new TextEncoder().encode('<h1>a</h1>')
    const b = new Uint8Array([0, 1, 2, 255])
    const joined = new Uint8Array([...worker, ...a, ...b])
    const assets = [
      { content: Buffer.from(a).toString('base64') },
      { content: Buffer.from(b).toString('base64') },
    ]
    expect(bundleHashOf(worker, assets)).toBe(sha256(joined))
    // Order is part of it; paths are not.
    expect(bundleHashOf(worker, [...assets].reverse())).not.toBe(sha256(joined))
  })

  it('is the module hash alone without public files', () => {
    const worker = new TextEncoder().encode('export default {}')
    expect(bundleHashOf(worker, [])).toBe(sha256(worker))
  })
})

describe('commitMessage', () => {
  it('puts the trailer in its own last paragraph', () => {
    expect(commitMessage('Fix the header', 'ab'.repeat(32))).toBe(
      `Fix the header\n\nBundle-Hash: ${'ab'.repeat(32)}\n`,
    )
  })

  it('keeps the default subject and leaves a message without a hash alone', () => {
    expect(commitMessage(undefined, 'cd'.repeat(32))).toBe(
      `marcapony app deploy\n\nBundle-Hash: ${'cd'.repeat(32)}\n`,
    )
    expect(commitMessage('  Plain  ')).toBe('Plain')
  })
})

describe('deploy', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'marcapony-bundle-hash-'))
    mkdirSync(join(dir, 'dist'), { recursive: true })
    mkdirSync(join(dir, 'public'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'index.js'), 'export default {}')
    writeFileSync(join(dir, 'public', 'index.html'), '<h1>hi</h1>')
    writeFileSync(join(dir, 'src.ts'), 'export const a = 1\n')
    writeFileSync(join(dir, '.dev.vars'), 'MARCAPONY_API_KEY=mpk_secret\n')
    writeFileSync(
      join(dir, 'marcapony.json'),
      JSON.stringify({
        app: 'hash-app',
        build: 'echo build',
        worker: 'dist/index.js',
        assets: 'public',
      }),
    )
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('pushes the commit with the hash of the bundle it then deploys', async () => {
    const pushed: PushSourceOptions[] = []
    let deployed: { worker: { content: string }; assets?: Array<{ content: string }> } | undefined
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      const ok = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
      if (u.endsWith('/source-head')) return ok({ data: { enabled: false } })
      if (u.endsWith('/validate')) return ok({ data: { ok: true } })
      if (u.endsWith('/source-token')) {
        return ok(
          {
            data: {
              repoName: 'app-1',
              remote: 'https://r/git/ns/app-1.git',
              branch: 'production',
              token: 'art_v1_x?expires=1',
              expiresAt: null,
            },
          },
          201,
        )
      }
      if (u.endsWith('/ext/v1/deployments')) {
        deployed = JSON.parse(String(init?.body))
        return ok({ data: { id: 'dep-1', status: 'live', hostname: null, error: null } }, 201)
      }
      throw new Error(`unexpected request ${u}`)
    }) as typeof fetch

    await runDeployDetailed({
      cwd: dir,
      cliEnv: 'local',
      env: {},
      fetchImpl: impl,
      runBuild: () => {},
      log: () => {},
      pushSourceImpl: async (o) => {
        pushed.push(o)
        return 'c'.repeat(40)
      },
    })

    expect(deployed).toBeDefined()
    const worker = Buffer.from(deployed!.worker.content, 'base64')
    const expected = bundleHashOf(worker, deployed!.assets ?? [])
    expect(deployed!.assets?.length).toBe(1)
    expect(pushed[0]?.bundleHash).toBe(expected)
  })
})
