import { describe, expect, it } from 'bun:test'
import { createClient } from '../index'
import { ValidationError } from '../errors'

const BASE = 'https://api.test/ext/v1'

function seller(respond: () => Response = () => Response.json({ data: { id: 'x' } })) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return respond()
  }) as typeof globalThis.fetch
  const mp = createClient({ apiKey: 'mpk_test', baseUrl: BASE, fetch, maxRetries: 2 })
  const scoped = mp.forRequest(
    new Request('https://app.test/', { headers: { 'x-marcapony-identity': 'a.b.c' } }),
  )
  return { me: scoped.me, calls }
}

describe('me.products', () => {
  it('reaches the seller routes', async () => {
    const { me, calls } = seller()
    await me.products.create({ name: 'Kupa' }, { idempotencyKey: 'k1' })
    await me.products.update('p1', { price: 120 })
    await me.products.submit('p1')
    await me.products.unpublish('p1')
    await me.products.setVariants('p1', { combinations: [] })
    expect(calls.map((c) => `${c.init.method} ${c.url.replace(BASE, '')}`)).toEqual([
      'POST /me/products',
      'PATCH /me/products/p1',
      'POST /me/products/p1/submit',
      'POST /me/products/p1/unpublish',
      'PUT /me/products/p1/variants',
    ])
    expect(new Headers(calls[0]!.init.headers).get('Idempotency-Key')).toBe('k1')
  })
})

describe('me.media.upload', () => {
  it('sends the raw bytes with their own type and an encoded file name', async () => {
    const { me, calls } = seller()
    const bytes = new Uint8Array([137, 80, 78, 71])
    await me.media.upload(bytes, { contentType: 'image/png', fileName: 'Büyük kupa.png' })
    const headers = new Headers(calls[0]!.init.headers)
    expect(calls[0]!.url).toBe(`${BASE}/me/media`)
    expect(headers.get('Content-Type')).toBe('image/png')
    expect(headers.get('X-File-Name')).toBe('B%C3%BCy%C3%BCk%20kupa.png')
    expect(calls[0]!.init.body).toBe(bytes)
  })

  it('takes the type from a Blob', async () => {
    const { me, calls } = seller()
    await me.media.upload(new Blob([new Uint8Array([1])], { type: 'image/webp' }))
    expect(new Headers(calls[0]!.init.headers).get('Content-Type')).toBe('image/webp')
  })

  it('refuses before sending: no type, empty, or over 10 MB', async () => {
    const { me, calls } = seller()
    await expect(me.media.upload(new Uint8Array([1]))).rejects.toBeInstanceOf(ValidationError)
    await expect(
      me.media.upload(new Uint8Array(0), { contentType: 'image/png' }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      me.media.upload(new Uint8Array(10 * 1024 * 1024 + 1), { contentType: 'image/png' }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(calls).toHaveLength(0)
  })

  it('is sent once without an idempotency key, retried with one', async () => {
    const failing = () =>
      Response.json({ error: { code: 'server_error', message: 'x' } }, { status: 503 })
    const once = seller(failing)
    await expect(
      once.me.media.upload(new Uint8Array([1]), { contentType: 'image/png' }),
    ).rejects.toThrow()
    expect(once.calls).toHaveLength(1)
    const retried = seller(failing)
    await expect(
      retried.me.media.upload(new Uint8Array([1]), {
        contentType: 'image/png',
        idempotencyKey: 'u1',
      }),
    ).rejects.toThrow()
    expect(retried.calls).toHaveLength(3)
  })
})
