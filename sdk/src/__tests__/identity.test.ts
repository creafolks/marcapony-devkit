import { describe, expect, it } from 'bun:test'
import { createClient, UnauthorizedError } from '../index'

const APP = 'app-1'
const BASE = 'https://api.test/ext/v1'

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function keyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
}

async function sign(
  pair: CryptoKeyPair,
  claims: Record<string, unknown>,
  kid = 'k1',
): Promise<string> {
  const input = `${b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }))}.${b64url(JSON.stringify(claims))}`
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    new TextEncoder().encode(input),
  )
  return `${input}.${b64url(new Uint8Array(sig))}`
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  return {
    aud: `app:${APP}`,
    sub: 'u1',
    kind: 'customer',
    email: 'a@b.co',
    perm: ['view'],
    iat: now,
    exp: now + 120,
    ...over,
  }
}

async function clientFor(pair: CryptoKeyPair, calls: string[] = []) {
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1' }] }), { status: 200 })
  }) as typeof globalThis.fetch
  return createClient({ apiKey: 'mpk_x', baseUrl: BASE, appId: APP, fetch: fetchImpl })
}

const requestWith = (token?: string) =>
  new Request('https://site.test/_apps/x/', {
    headers: token ? { 'x-marcapony-identity': token } : {},
  })

describe('identity()', () => {
  it('returns the signed-in person for a valid token and fetches the JWKS once', async () => {
    const pair = await keyPair()
    const calls: string[] = []
    const mp = await clientFor(pair, calls)
    const token = await sign(pair, claims())
    const who = await mp.identity(requestWith(token))
    expect(who).toMatchObject({
      sub: 'u1',
      kind: 'customer',
      email: 'a@b.co',
      permissions: ['view'],
    })
    expect(who?.can('view')).toBe(true)
    expect(who?.can('approve')).toBe(false)
    await mp.identity(requestWith(token))
    expect(calls).toEqual(['https://api.test/.well-known/marcapony-identity-keys.json'])
  })

  it('exposes preview for a token the platform marked as a preview, false otherwise', async () => {
    const pair = await keyPair()
    const mp = await clientFor(pair)
    const normal = await mp.identity(requestWith(await sign(pair, claims())))
    expect(normal?.preview).toBe(false)
    const previewing = await mp.identity(
      requestWith(await sign(pair, claims({ prv: true, act: 'owner-1' }))),
    )
    expect(previewing?.preview).toBe(true)
    const member = await mp.identity(requestWith(await sign(pair, claims({ kind: 'member' }))))
    expect(member).toMatchObject({ kind: 'member', preview: false })
  })

  it('returns null for no header, a forged signature, another app, or an expired token', async () => {
    const pair = await keyPair()
    const mp = await clientFor(pair)
    expect(await mp.identity(requestWith())).toBeNull()
    expect(await mp.identity(requestWith(await sign(await keyPair(), claims())))).toBeNull()
    expect(
      await mp.identity(requestWith(await sign(pair, claims({ aud: 'app:other' })))),
    ).toBeNull()
    const past = Math.floor(Date.now() / 1000) - 600
    expect(
      await mp.identity(requestWith(await sign(pair, claims({ iat: past, exp: past + 120 })))),
    ).toBeNull()
  })

  it('refuses to run without the app id instead of trusting every audience', async () => {
    const mp = createClient({ apiKey: 'mpk_x', baseUrl: BASE })
    await expect(mp.identity(requestWith('x'))).rejects.toThrow('app id')
  })
})

describe('forRequest()', () => {
  it('sends the runtime key plus the identity header on /me calls only', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string> })
      return new Response(JSON.stringify({ data: [], meta: { page: 1, perPage: 50, total: 0 } }), {
        status: 200,
      })
    }) as typeof globalThis.fetch
    const mp = createClient({ apiKey: 'mpk_x', baseUrl: BASE, appId: APP, fetch: fetchImpl })
    const scoped = mp.forRequest(requestWith('the.token.value'))
    await scoped.me.reservations.list()
    expect(seen[0]!.url).toBe(`${BASE}/me/reservations`)
    expect(seen[0]!.headers.Authorization).toBe('Bearer mpk_x')
    expect(seen[0]!.headers['x-marcapony-identity']).toBe('the.token.value')
    expect(Object.keys(scoped)).toEqual(['kind', 'me', 'reservations', 'orders', 'customers'])
    // Not a JWS payload: no kind can be read.
    expect(scoped.kind).toBeNull()
  })

  it('reads the kind from the token as a hint, and reaches the new me calls', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ data: [], meta: { page: 1, perPage: 50, total: 0 } }), {
        status: 200,
      })
    }) as typeof globalThis.fetch
    const mp = createClient({ apiKey: 'mpk_x', baseUrl: BASE, appId: APP, fetch: fetchImpl })
    const token = await sign(await keyPair(), claims())
    const scoped = mp.forRequest(requestWith(token))
    expect(scoped.kind).toBe('customer')
    await scoped.me.paymentLinks.list({ status: 'pending' })
    await scoped.me.formSubmissions.list()
    await scoped.me.reservations.list({ status: 'approved', from: '2026-11-01' })
    expect(seen).toEqual([
      `${BASE}/me/payment-links?status=pending`,
      `${BASE}/me/form-submissions`,
      `${BASE}/me/reservations?status=approved&from=2026-11-01`,
    ])
  })

  it('sends the identity on the account routes a member tool may reach', async () => {
    const seen: Array<{ url: string; method?: string; headers: Record<string, string> }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        method: init?.method,
        headers: init?.headers as Record<string, string>,
      })
      return new Response(JSON.stringify({ data: {} }), { status: 200 })
    }) as typeof globalThis.fetch
    const mp = createClient({ apiKey: 'mpk_x', baseUrl: BASE, appId: APP, fetch: fetchImpl })
    const scoped = mp.forRequest(requestWith('member.token.value'))
    await scoped.reservations.updateStatus('r/1', { status: 'approved' })
    await scoped.customers.get('c1')
    expect(seen.map((s) => [s.method, s.url])).toEqual([
      ['PATCH', `${BASE}/reservations/r%2F1`],
      ['GET', `${BASE}/customers/c1`],
    ])
    expect(seen.every((s) => s.headers['x-marcapony-identity'] === 'member.token.value')).toBe(true)
    expect(Object.keys(scoped.orders)).toEqual(['list', 'get'])
    expect(Object.keys(scoped.customers)).toEqual(['list', 'get'])
  })

  it('throws Unauthorized when the request carries no identity', () => {
    const mp = createClient({ apiKey: 'mpk_x', baseUrl: BASE, appId: APP })
    expect(() => mp.forRequest(requestWith())).toThrow(UnauthorizedError)
  })
})

describe('hardening', () => {
  it('encodes record ids into one path segment and refuses dot segments', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ data: {} }), { status: 200 })
    }) as typeof globalThis.fetch
    const mp = createClient({ apiKey: 'mpk_x', baseUrl: BASE, appId: APP, fetch: fetchImpl })
    const scoped = mp.forRequest(requestWith('t.t.t'))
    await scoped.me.reservations.get('a/b?x=1')
    expect(seen[0]).toBe(`${BASE}/me/reservations/a%2Fb%3Fx%3D1`)
    expect(() => scoped.me.orders.get('..')).toThrow('invalid record id')
  })

  it('stops trusting an expired JWKS cache when the refetch fails', async () => {
    const pair = await keyPair()
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
    let failing = false
    let nowMs = Date.now()
    const fetchImpl = (async (_url: string | URL | Request) => {
      if (failing) throw new Error('network down')
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1' }] }), { status: 200 })
    }) as typeof globalThis.fetch
    const { createIdentityVerifier } = await import('../identity')
    const verify = createIdentityVerifier({
      appId: APP,
      baseUrl: BASE,
      fetch: fetchImpl,
      now: () => nowMs,
    })
    const token = await sign(pair, claims({ exp: Math.floor(nowMs / 1000) + 3600 }))
    expect(await verify(token)).not.toBeNull()
    failing = true
    nowMs += 6 * 60_000
    expect(await verify(token)).toBeNull()
    failing = false
    nowMs += 10_000
    expect(await verify(token)).not.toBeNull()
  })
})
