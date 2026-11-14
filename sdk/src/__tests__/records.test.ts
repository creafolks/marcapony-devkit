import { describe, expect, it } from 'bun:test'
import { ConflictError, createClient, type MarcaponyError, NotFoundError } from '../index'

const BASE = 'https://api.test/ext/v1'

interface Seen {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

type Answer = { status?: number; body: unknown }

function scopedClient(answers: Answer[]) {
  const seen: Seen[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      method: init?.method ?? 'GET',
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const answer = answers.shift() ?? { body: { data: {} } }
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 })
  }) as typeof globalThis.fetch
  const mp = createClient({ apiKey: 'mpk_x', baseUrl: BASE, appId: 'app-1', fetch: fetchImpl })
  const request = new Request('https://site.test/_apps/x/', {
    headers: { 'x-marcapony-identity': 'a.b.c' },
  })
  return { seen, me: mp.forRequest(request).me }
}

const record = { key: 'k1', data: { status: 'open' }, version: 1, createdAt: 't', updatedAt: 't' }
const failure = (status: number, code: string): Answer => ({
  status,
  body: { error: { code, message: code } },
})

interface Entry extends Record<string, unknown> {
  status: string
}

describe('me.records', () => {
  it('reads one record and sends the identity', async () => {
    const { seen, me } = scopedClient([{ body: { data: record } }])
    const found = await me.records<Entry>('entries').get('k1')
    expect(found?.data.status).toBe('open')
    expect(seen[0]).toMatchObject({ method: 'GET', url: `${BASE}/me/records/entries/k1` })
    expect(seen[0]?.headers['x-marcapony-identity']).toBe('a.b.c')
  })

  it('answers null for a missing record, but not for a missing collection', async () => {
    const { me } = scopedClient([failure(404, 'not_found'), failure(404, 'collection_not_found')])
    expect(await me.records('entries').get('none')).toBeNull()
    const missing = await me
      .records('nothing')
      .get('k')
      .catch((err: unknown) => err)
    expect(missing).toBeInstanceOf(NotFoundError)
    expect((missing as MarcaponyError).code).toBe('collection_not_found')
  })

  it('puts a record whole, with If-Match only when a version is given', async () => {
    const { seen, me } = scopedClient([{ body: { data: record } }, { body: { data: record } }])
    const entries = me.records<Entry>('entries')
    await entries.put('2026-11-14', { status: 'open' })
    await entries.put('2026-11-14', { status: 'done' }, { ifVersion: 3, idempotencyKey: 'idem-1' })
    expect(seen[0]).toMatchObject({
      method: 'PUT',
      url: `${BASE}/me/records/entries/2026-11-14`,
      body: { data: { status: 'open' } },
    })
    expect(seen[0]?.headers['If-Match']).toBeUndefined()
    expect(seen[1]?.headers['If-Match']).toBe('3')
    expect(seen[1]?.headers['Idempotency-Key']).toBe('idem-1')
  })

  it('raises ConflictError at a stale version and does not retry the write', async () => {
    const { seen, me } = scopedClient([failure(409, 'conflict')])
    await expect(
      me.records('entries').put('k1', { status: 'x' }, { ifVersion: 1 }),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(seen).toHaveLength(1)
  })

  it('creates under a generated key', async () => {
    const { seen, me } = scopedClient([{ status: 201, body: { data: record } }])
    const created = await me.records<Entry>('entries').create({ status: 'open' })
    expect(created.key).toBe('k1')
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: `${BASE}/me/records/entries`,
      body: { data: { status: 'open' } },
    })
  })

  it('deletes, and says whether there was a record', async () => {
    const { seen, me } = scopedClient([
      { body: { data: { key: 'k1', deleted: true } } },
      failure(404, 'not_found'),
    ])
    const entries = me.records('entries')
    expect(await entries.delete('k1', { ifVersion: 2 })).toBe(true)
    expect(await entries.delete('k1')).toBe(false)
    expect(seen[0]).toMatchObject({ method: 'DELETE', url: `${BASE}/me/records/entries/k1` })
    expect(seen[0]?.headers['If-Match']).toBe('2')
  })

  it('lists with an index filter and hands back the cursor', async () => {
    const { seen, me } = scopedClient([{ body: { data: [record], meta: { nextCursor: 'c2' } } }])
    const page = await me
      .records<Entry>('entries')
      .list({ index: 'loggedAt', gte: '2026-11-01', order: 'desc', limit: 50 })
    expect(page.meta.nextCursor).toBe('c2')
    expect(page.data[0]?.key).toBe('k1')
    expect(seen[0]?.url).toBe(
      `${BASE}/me/records/entries?index=loggedAt&gte=2026-11-01&order=desc&limit=50`,
    )
  })

  it('keeps a key inside its path segment and refuses dot segments', async () => {
    const { seen, me } = scopedClient([{ body: { data: record } }])
    await me.records('entries').get('a/b')
    expect(seen[0]?.url).toBe(`${BASE}/me/records/entries/a%2Fb`)
    expect(() => me.records('entries').put('..', {})).toThrow('invalid record id')
  })
})
