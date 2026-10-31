import { describe, expect, it } from 'bun:test'
import { createClient } from '../index'
import {
  InsufficientScopeError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
} from '../errors'

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function makeFetch(responses: Array<Response | (() => Response)>): {
  fetch: typeof globalThis.fetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = responses.shift()
    if (!next) throw new Error('unexpected extra request')
    return typeof next === 'function' ? next() : next
  }) as typeof globalThis.fetch
  return { fetch: fetchImpl, calls }
}

const KEY = 'mpk_test-key'

describe('createClient', () => {
  it('sends the bearer key and unwraps the envelope', async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ data: { id: 's1', name: 'Acme' } })])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })
    const site = await mp.site.get()
    expect(site).toEqual({ id: 's1', name: 'Acme' } as never)
    expect(calls[0]?.url).toBe('https://x.test/ext/v1/site')
    expect((calls[0]?.init.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${KEY}`)
  })

  it('serializes list params and returns data + meta', async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ data: [], meta: { page: 2, perPage: 10, total: 0 } }),
    ])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })
    const page = await mp.products.list({ page: 2, perPage: 10, category: 'tours' })
    expect(page.meta).toEqual({ page: 2, perPage: 10, total: 0 })
    expect(calls[0]?.url).toBe('https://x.test/ext/v1/products?page=2&perPage=10&category=tours')
  })

  it('passes the Idempotency-Key on creates', async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ data: { id: 'pl1' } }, 201)])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })
    await mp.paymentLinks.create(
      { title: 'Transfer', amount: 80, currency: 'EUR' },
      { idempotencyKey: 'req-1' },
    )
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBe('req-1')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('maps the closed error codes to typed classes', async () => {
    const { fetch } = makeFetch([
      jsonResponse(
        {
          error: { code: 'insufficient_scope', message: 'This key lacks the "orders:write" scope' },
        },
        403,
      ),
    ])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })
    const err = await mp.orders.list().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InsufficientScopeError)
    expect((err as InsufficientScopeError).status).toBe(403)
    // The message alone must identify the failing request — integrators
    // often log nothing else.
    expect((err as InsufficientScopeError).message).toBe(
      'GET /orders → 403 insufficient_scope: This key lacks the "orders:write" scope',
    )
  })

  it('surfaces validation fields', async () => {
    const { fetch } = makeFetch([
      jsonResponse(
        {
          error: {
            code: 'validation_failed',
            message: 'Invalid request payload',
            fields: [{ field: 'customerEmail', message: 'Invalid email' }],
          },
        },
        400,
      ),
    ])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })
    const err = await mp.reservations
      .create({
        customerName: 'A',
        customerEmail: 'bad',
        requestedDate: '2026-08-01',
        requestedTime: '10:00',
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).fields[0]?.field).toBe('customerEmail')
    expect((err as ValidationError).message).toBe(
      'POST /reservations → 400 validation_failed: Invalid request payload [customerEmail: Invalid email]',
    )
  })

  it('retries GETs on 5xx', async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ error: { code: 'server_error', message: 'boom' } }, 500),
      jsonResponse({ data: [] }),
    ])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })
    const regions = await mp.regions.list()
    expect(regions).toEqual([])
    expect(calls.length).toBe(2)
  })

  it('does NOT retry a POST without an idempotency key', async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ error: { code: 'server_error', message: 'boom' } }, 500),
    ])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })
    const err = await mp.customers.create({ name: 'A', email: 'a@b.co' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(calls.length).toBe(1)
  })

  it('retries a POST when an idempotency key makes it safe', async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ error: { code: 'server_error', message: 'boom' } }, 500),
      jsonResponse({ data: { id: 'c1' } }, 201),
    ])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })
    const customer = await mp.customers.create(
      { name: 'A', email: 'a@b.co' },
      { idempotencyKey: 'req-2' },
    )
    expect((customer as { id: string }).id).toBe('c1')
    expect(calls.length).toBe(2)
  })

  it('4xx errors never retry', async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ error: { code: 'not_found', message: 'Product not found' } }, 404),
    ])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })
    const err = await mp.products.get('nope').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NotFoundError)
    expect(calls.length).toBe(1)
  })

  // Anything in front of /ext/v1 (proxy, gateway, CDN) answers with a body that
  // has no envelope; the status still has to pick the right error class.
  it('classifies an envelope-less error body by its status', async () => {
    const { fetch } = makeFetch([new Response('<html>Not Found</html>', { status: 404 })])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })
    const err = await mp.products.get('nope').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NotFoundError)
  })

  it('raises rather than sleeping when Retry-After exceeds the cap', async () => {
    const { fetch, calls } = makeFetch([
      new Response('<html>Too Many Requests</html>', {
        status: 429,
        headers: { 'Retry-After': '3600' },
      }),
    ])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })
    const started = Date.now()
    const err = await mp.products.list().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect((err as RateLimitError).retryAfter).toBe(3600)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(calls.length).toBe(1)
  })

  it('does not resolve a 2xx whose body is not valid JSON', async () => {
    const { fetch, calls } = makeFetch([
      new Response('{"data": tru', { status: 200 }),
      new Response('{"data": tru', { status: 200 }),
      new Response('{"data": tru', { status: 200 }),
    ])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })
    const err = await mp.products.list().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServerError)
    expect(calls.length).toBe(3)
  })

  it('refuses a secret key in a browser unless explicitly allowed', () => {
    const g = globalThis as { document?: unknown }
    g.document = {}
    try {
      expect(() => createClient({ apiKey: KEY })).toThrow(/browser/)
      expect(() => createClient({ apiKey: KEY, dangerouslyAllowBrowser: true })).not.toThrow()
    } finally {
      delete g.document
    }
  })

  // A Web/Service Worker has no `window` but still ships in a public bundle.
  it('refuses a secret key in a worker that has no window', () => {
    const g = globalThis as { importScripts?: unknown }
    g.importScripts = (): void => {}
    try {
      expect(() => createClient({ apiKey: KEY })).toThrow(/browser/)
    } finally {
      delete g.importScripts
    }
  })

  it('does not treat a bare `window` global as a browser', () => {
    const g = globalThis as { window?: unknown }
    g.window = {}
    try {
      expect(() => createClient({ apiKey: KEY })).not.toThrow()
    } finally {
      delete g.window
    }
  })
})

describe('blog and media resources', () => {
  it('addresses each post operation at the path the surface publishes', async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ data: [], meta: { page: 1, perPage: 50, total: 0 } }),
      jsonResponse({ data: { id: 'p1' } }),
      jsonResponse({ data: { id: 'p1' } }),
      jsonResponse({ data: { id: 'p1' } }),
      jsonResponse({ data: { id: 'p1' } }),
      jsonResponse({ data: { success: true } }),
    ])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })

    await mp.posts.list({ published: 'true', kind: 'event' })
    await mp.posts.create({ title: 't', content: '<p>c</p>' })
    await mp.posts.update('p1', { title: 't2', content: '<p>c</p>' })
    await mp.posts.publish('p1')
    await mp.posts.unpublish('p1')
    await mp.posts.delete('p1', { deleteTranslations: true })

    expect(calls[0]?.url).toBe('https://x.test/ext/v1/posts?published=true&kind=event')
    expect(calls[1]?.init.method).toBe('POST')
    expect(calls[2]?.init.method).toBe('PATCH')
    expect(calls[3]?.url).toBe('https://x.test/ext/v1/posts/p1/publish')
    expect(calls[4]?.url).toBe('https://x.test/ext/v1/posts/p1/unpublish')
    // The surface's first DELETE — the transport had no such verb before it.
    expect(calls[5]?.init.method).toBe('DELETE')
    expect(calls[5]?.url).toBe('https://x.test/ext/v1/posts/p1?deleteTranslations=true')
  })

  it('sends a translation create to the post it translates, not to /posts', async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ data: { id: 'p2' } })])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })
    const created = await mp.posts.createTranslation('p1', {
      locale: 'en',
      title: 't',
      content: '<p>c</p>',
    })
    expect(calls[0]?.url).toBe('https://x.test/ext/v1/posts/p1/translations')
    // The translation is its own post: the id it answers with is not the one
    // that was addressed.
    expect((created as { id: string }).id).toBe('p2')
  })

  it('reaches authors, categories and media at their own paths', async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ data: [] }),
      jsonResponse({ data: { id: 'a1' } }),
      jsonResponse({ data: [] }),
      jsonResponse({ data: { id: 'c2' } }),
      jsonResponse({ data: [], meta: { page: 1, perPage: 50, total: 0 } }),
      jsonResponse({ data: { id: 'asset-1' } }),
    ])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })

    await mp.blogAuthors.list()
    await mp.blogAuthors.delete('a1')
    await mp.blogCategories.list({ locale: 'tr' })
    await mp.blogCategories.createTranslation('c1', { locale: 'en', name: 'News' })
    await mp.media.list({ fileType: 'image' })
    await mp.media.upload({ url: 'https://cdn.example.com/a.webp' })

    expect(calls[0]?.url).toBe('https://x.test/ext/v1/blog-authors')
    expect(calls[1]?.init.method).toBe('DELETE')
    expect(calls[2]?.url).toBe('https://x.test/ext/v1/blog-categories?locale=tr')
    expect(calls[3]?.url).toBe('https://x.test/ext/v1/blog-categories/c1/translation')
    expect(calls[4]?.url).toBe('https://x.test/ext/v1/media?fileType=image')
    expect(calls[5]?.init.method).toBe('POST')
  })

  it('passes an idempotency key through the blog and media creates', async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ data: { id: 'p1' } }),
      jsonResponse({ data: { id: 'asset-1' } }),
    ])
    const mp = createClient({ apiKey: KEY, baseUrl: 'https://x.test/ext/v1', fetch })
    await mp.posts.create({ title: 't', content: 'c' }, { idempotencyKey: 'k1' })
    await mp.media.upload({ url: 'https://cdn.example.com/a.webp' }, { idempotencyKey: 'k2' })

    const header = (i: number): string | undefined =>
      (calls[i]?.init.headers as Record<string, string> | undefined)?.['Idempotency-Key']
    expect(header(0)).toBe('k1')
    expect(header(1)).toBe('k2')
  })
})
