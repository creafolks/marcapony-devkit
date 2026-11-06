import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchKeyInfo, retirePreviousKeys } from '../api'
import { warnIfKeyExpiring } from '../deploy'
import { runLink } from '../link'

// Key rotation on the CLI side: `link --ci`, retiring the user's earlier key
// after a re-link, and the expiry warning.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'marcapony-keys-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Call = { url: string; init: RequestInit }
function routeFetch(routes: Record<string, () => Response>): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init: init ?? {} })
    const route = Object.entries(routes).find(([suffix]) => u.endsWith(suffix))
    if (!route) throw new Error(`unexpected request ${u}`)
    return route[1]()
  }) as typeof fetch
  return { fetch: impl, calls }
}

const LINKED = {
  appSlug: 'booking',
  environmentName: 'test',
  key: 'mpk_newkey',
  baseUrl: 'http://localhost:4000/ext/v1',
  keyId: 'key-2',
  expiresAt: '2027-02-04T00:00:00.000Z',
}

describe('marcapony app link', () => {
  it('retires the earlier key with the new one, after it is written', async () => {
    const { fetch, calls } = routeFetch({
      '/apps/link': () => json(LINKED),
      '/keys/retire-previous': () => json({ data: { revoked: 1 } }),
      '/capabilities': () => json({ data: [] }),
    })
    const logs: string[] = []
    await runLink({
      cwd: dir,
      code: 'mpl_x',
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      log: (m) => logs.push(m),
    })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: 'mpl_x' })
    const retire = calls.find((c) => c.url.endsWith('/keys/retire-previous'))
    expect(retire?.init.method).toBe('POST')
    expect((retire?.init.headers as Record<string, string> | undefined)?.Authorization).toBe(
      'Bearer mpk_newkey',
    )
    expect(logs.some((l) => l.includes('1 of your previous key(s)'))).toBe(true)
    expect(logs.some((l) => l.includes('Key expires    2027-02-04'))).toBe(true)
    expect(logs.join('\n')).not.toContain('mpk_newkey')
  })

  it('--ci asks for a CI key and retires nothing', async () => {
    const { fetch, calls } = routeFetch({
      '/apps/link': () => json(LINKED),
      '/capabilities': () => json({ data: [] }),
    })
    const logs: string[] = []
    await runLink({
      cwd: dir,
      code: 'mpl_x',
      ci: true,
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      log: (m) => logs.push(m),
    })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: 'mpl_x', ci: true })
    expect(calls.some((c) => c.url.includes('retire-previous'))).toBe(false)
    expect(logs.some((l) => l.includes("pipeline's secret store"))).toBe(true)
  })

  it('a failed retirement does not fail the link', async () => {
    const { fetch } = routeFetch({
      '/apps/link': () => json(LINKED),
      '/keys/retire-previous': () =>
        json({ error: { code: 'server_error', message: 'boom' } }, 500),
      '/capabilities': () => json({ data: [] }),
    })
    const logs: string[] = []
    await runLink({
      cwd: dir,
      code: 'mpl_x',
      cliEnv: 'local',
      env: {},
      fetchImpl: fetch,
      log: (m) => logs.push(m),
    })
    expect(logs.some((l) => l.includes('not revoked'))).toBe(true)
  })
})

describe('api helpers', () => {
  it('retirePreviousKeys is null on an older platform', async () => {
    const { fetch } = routeFetch({ '/keys/retire-previous': () => json({}, 404) })
    expect(await retirePreviousKeys('http://x', 'mpk_k', fetch)).toBeNull()
  })

  it('fetchKeyInfo reads the key route, then falls back to me', async () => {
    const info = { id: 'k', expiresAt: '2026-11-20T00:00:00.000Z', cliLabel: 'local' }
    const direct = routeFetch({ '/keys/current': () => json({ data: info }) })
    expect(await fetchKeyInfo('http://x', 'mpk_k', direct.fetch)).toEqual(info as never)
    const fallback = routeFetch({
      '/keys/current': () => json({}, 404),
      '/me': () => json({ data: { key: info } }),
    })
    expect(await fetchKeyInfo('http://x', 'mpk_k', fallback.fetch)).toEqual(info as never)
    const none = routeFetch({ '/keys/current': () => json({}, 404), '/me': () => json({}, 401) })
    expect(await fetchKeyInfo('http://x', 'mpk_k', none.fetch)).toBeNull()
  })
})

describe('expiry warning', () => {
  const now = new Date('2026-11-07T00:00:00.000Z')
  const run = async (expiresAt: string | null, cliLabel: string | null = 'local') => {
    const { fetch } = routeFetch({
      '/keys/current': () => json({ data: { id: 'k', expiresAt, cliLabel } }),
    })
    const logs: string[] = []
    await warnIfKeyExpiring('http://x', 'mpk_k', fetch, (m) => logs.push(m), now)
    return logs
  }

  it('warns within 14 days with the re-link command', async () => {
    const logs = await run('2026-11-17T00:00:00.000Z')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('expires in 10 day(s), on 2026-11-17')
    expect(logs[0]).toContain('`marcapony app link`')
  })

  it('names --ci for a pipeline key', async () => {
    expect((await run('2026-11-10T00:00:00.000Z', 'ci'))[0]).toContain('`marcapony app link --ci`')
  })

  it('stays quiet further out, without an expiry, or when the request fails', async () => {
    expect(await run('2026-12-30T00:00:00.000Z')).toEqual([])
    expect(await run(null)).toEqual([])
    const logs: string[] = []
    const failing = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    await warnIfKeyExpiring('http://x', 'mpk_k', failing, (m) => logs.push(m), now)
    expect(logs).toEqual([])
  })
})
