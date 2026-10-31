import { describe, expect, it } from 'bun:test'
import { createClient } from '../index'
import { RateLimitError, ServerError } from '../errors'
import { MAX_RETRY_DELAY_MS, retryDelayMs } from '../transport'

function rateLimited(retryAfter: number | null): RateLimitError {
  return new RateLimitError(429, 'rate_limited', 'slow down', [], retryAfter)
}

describe('retryDelayMs', () => {
  it('draws the backoff from the full jitter range', () => {
    const boom = new ServerError(500, 'server_error', 'boom')
    expect(retryDelayMs(1, boom, () => 0)).toBe(0)
    expect(retryDelayMs(1, boom, () => 0.5)).toBe(250)
    expect(retryDelayMs(2, boom, () => 0.5)).toBe(500)
    expect(retryDelayMs(3, boom, () => 0.999)).toBeLessThan(2000)
  })

  it('honors Retry-After as given, up to the cap', () => {
    expect(retryDelayMs(1, rateLimited(2), () => 0)).toBe(2000)
    expect(retryDelayMs(1, rateLimited(600), () => 0)).toBe(MAX_RETRY_DELAY_MS)
  })

  it('falls back to jittered backoff when a 429 has no Retry-After', () => {
    expect(retryDelayMs(1, rateLimited(null), () => 0.5)).toBe(250)
  })
})

describe('baseUrl', () => {
  it('drops any trailing slashes once', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ data: {} }), { status: 200 })
    }) as typeof globalThis.fetch
    const mp = createClient({
      apiKey: 'mpk_x',
      baseUrl: 'https://x.test/ext/v1//',
      fetch: fetchImpl,
    })
    await mp.site.get()
    expect(urls[0]).toBe('https://x.test/ext/v1/site')
  })
})

describe('deletes', () => {
  it('resolve to undefined whatever the envelope carries, and still require one', async () => {
    const bodies = [{ data: { deleted: true } }, { data: null }, { data: { field: 'post' } }]
    const fetchImpl = (async (_url: string | URL | Request) => {
      const body = bodies.shift()
      return new Response(body ? JSON.stringify(body) : '', { status: 200 })
    }) as typeof globalThis.fetch
    const mp = createClient({ apiKey: 'mpk_x', baseUrl: 'https://x.test/ext/v1', fetch: fetchImpl })
    expect(await mp.blogCategories.delete('c1')).toBeUndefined()
    expect(await mp.blogAuthors.delete('a1')).toBeUndefined()
    expect(await mp.posts.delete('p1')).toBeUndefined()
    const err = await mp.posts.delete('p2').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServerError)
  })
})
