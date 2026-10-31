import { describe, expect, it } from 'bun:test'
import { createClient } from '../index'
import { path } from '../path'

const KEY = 'mpk_test-key'
const BASE = 'https://x.test/ext/v1'

function recorder(): { fetch: typeof globalThis.fetch; urls: string[] } {
  const urls: string[] = []
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url))
    return new Response(JSON.stringify({ data: { id: 'x' } }), { status: 200 })
  }) as typeof globalThis.fetch
  return { fetch: fetchImpl, urls }
}

/** Works whether the call throws synchronously or rejects. */
async function failure(call: () => Promise<unknown>): Promise<unknown> {
  return Promise.resolve()
    .then(call)
    .then(
      () => null,
      (e: unknown) => e,
    )
}

describe('path', () => {
  it('encodes every interpolated value as one segment', () => {
    expect(<string>path`/posts/${'a/b'}/translations/${'en?x=1'}`).toBe(
      '/posts/a%2Fb/translations/en%3Fx%3D1',
    )
    expect(<string>path`/site`).toBe('/site')
  })

  it('refuses empty, `.` and `..` segments', () => {
    for (const bad of ['', '.', '..']) {
      expect(() => path`/posts/${bad}`).toThrow(/invalid record id/)
    }
  })

  it('keeps `..` inside a longer value as an encoded segment', () => {
    expect(<string>path`/posts/${'../blog-authors/x'}`).toBe('/posts/..%2Fblog-authors%2Fx')
  })
})

describe('record ids in client calls', () => {
  const cases: Array<{
    name: string
    call: (mp: ReturnType<typeof createClient>, id: string) => Promise<unknown>
    prefix: string
    suffix?: string
  }> = [
    { name: 'products.get', call: (mp, id) => mp.products.get(id), prefix: '/products/' },
    { name: 'posts.get', call: (mp, id) => mp.posts.get(id), prefix: '/posts/' },
    {
      name: 'posts.publish',
      call: (mp, id) => mp.posts.publish(id),
      prefix: '/posts/',
      suffix: '/publish',
    },
    { name: 'blogAuthors.get', call: (mp, id) => mp.blogAuthors.get(id), prefix: '/blog-authors/' },
    {
      name: 'blogCategories.delete',
      call: (mp, id) => mp.blogCategories.delete(id),
      prefix: '/blog-categories/',
    },
    { name: 'media.get', call: (mp, id) => mp.media.get(id), prefix: '/media/' },
    {
      name: 'reservations.updateStatus',
      call: (mp, id) => mp.reservations.updateStatus(id, { status: 'approved' }),
      prefix: '/reservations/',
    },
  ]

  const encoded: Array<[string, string]> = [
    ['../x', '..%2Fx'],
    ['a/b', 'a%2Fb'],
    ['a?b=c', 'a%3Fb%3Dc'],
  ]

  for (const c of cases) {
    for (const [raw, enc] of encoded) {
      it(`${c.name} encodes ${JSON.stringify(raw)}`, async () => {
        const { fetch, urls } = recorder()
        const mp = createClient({ apiKey: KEY, baseUrl: BASE, fetch })
        await c.call(mp, raw)
        expect(urls[0]).toBe(`${BASE}${c.prefix}${enc}${c.suffix ?? ''}`)
      })
    }

    for (const bad of ['', '.', '..']) {
      it(`${c.name} refuses ${JSON.stringify(bad)} without a request`, async () => {
        const { fetch, urls } = recorder()
        const mp = createClient({ apiKey: KEY, baseUrl: BASE, fetch })
        const err = await failure(() => c.call(mp, bad))
        expect(err).toBeInstanceOf(Error)
        expect((err as Error).message).toMatch(/invalid record id/)
        expect(urls.length).toBe(0)
      })
    }
  }

  it('encodes both the post id and the locale of a translation', async () => {
    const { fetch, urls } = recorder()
    const mp = createClient({ apiKey: KEY, baseUrl: BASE, fetch })
    await mp.posts.getTranslation('p/1', '../en')
    expect(urls[0]).toBe(`${BASE}/posts/p%2F1/translations/..%2Fen`)
    const err = await failure(() => mp.posts.getTranslation('p1', '..'))
    expect((err as Error).message).toMatch(/invalid record id/)
  })

  it('encodes ids on the scoped me and member clients', async () => {
    const { fetch, urls } = recorder()
    const mp = createClient({ apiKey: KEY, baseUrl: BASE, fetch })
    const scoped = mp.forRequest(
      new Request('https://app.test/', { headers: { 'x-marcapony-identity': 'a.b.c' } }),
    )
    await scoped.me.reservations.get('a?b=c')
    await scoped.orders.get('../x')
    expect(urls).toEqual([`${BASE}/me/reservations/a%3Fb%3Dc`, `${BASE}/orders/..%2Fx`])
    const err = await failure(() => scoped.customers.get('.'))
    expect((err as Error).message).toMatch(/invalid record id/)
  })
})
