import { describe, expect, it } from 'bun:test'
import { createClient, END_USER_COOKIE, personasHandler } from '../index'

const BASE = 'https://x.test/ext/v1'
const APP = 'https://game.example'
const SECRET = 'k'.repeat(43)
const CONVERSATION = '4f6c2a9e-1b3d-4c5e-8f70-123456789abc'
const ROUTE = `${APP}/api/chat/barista/conversations/${CONVERSATION}`

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> }
type Responder = (call: Call) => Response | Promise<Response>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeFetch(responders: Responder[]) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body:
        typeof init?.body === 'string'
          ? JSON.parse(init.body)
          : init?.body instanceof FormData
            ? Object.fromEntries(init.body.entries())
            : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    calls.push(call)
    const next = responders.shift()
    if (!next) throw new Error(`unexpected request ${call.method} ${call.url}`)
    return next(call)
  }) as typeof globalThis.fetch
  return { fetch: fetchImpl, calls }
}

function setup(
  responders: Responder[],
  options: Partial<Parameters<typeof personasHandler>[1]> = {},
) {
  const { fetch, calls } = makeFetch(responders)
  const mp = createClient({ apiKey: 'mpk_test', baseUrl: BASE, fetch })
  const handler = personasHandler(mp, { secret: SECRET, fetch, ...options })
  return { handler, calls }
}

const started = () =>
  jsonResponse(
    { data: { conversationId: CONVERSATION, channel: 'app', storesTranscripts: false } },
    201,
  )

const reply = () =>
  jsonResponse({
    data: {
      messageId: 'a1',
      text: 'An espresso.',
      signature: 'sig-a1',
      userMessageId: 'u1',
      userSignature: 'sig-u1',
      turn: 1,
    },
  })

function post(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function cookieValue(response: Response): string {
  const header = response.headers.get('Set-Cookie') ?? ''
  return header.split(';')[0]!.slice(`${END_USER_COOKIE}=`.length)
}

async function hmacBase64url(key: Uint8Array, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message)),
  )
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

describe('personasHandler setup', () => {
  it('refuses to run without a real secret', () => {
    const mp = createClient({ apiKey: 'mpk_test', baseUrl: BASE })
    expect(() => personasHandler(mp, { secret: '' })).toThrow('MARCAPONY_APP_SECRET')
    expect(() => personasHandler(mp, { secret: 'short' })).toThrow('at least 32')
  })
})

describe('the visitor cookie', () => {
  it('is issued on the first conversation, signed as documented, and passed as the end user', async () => {
    const { handler, calls } = setup([started])
    const response = await handler(
      post(
        `${APP}/api/chat/barista/conversations`,
        { locale: 'tr' },
        {
          'cf-connecting-ip': '203.0.113.9',
        },
      ),
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      conversationId: CONVERSATION,
      storesTranscripts: false,
      testMode: false,
    })
    const header = response.headers.get('Set-Cookie')!
    for (const attribute of ['Path=/', 'Max-Age=31536000', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
      expect(header).toContain(attribute)
    }
    const [id, signature] = cookieValue(response).split('.') as [string, string]
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    // Cookie key = HMAC-SHA256(secret, label); signature = HMAC-SHA256(cookie key, id).
    const cookieKey = Uint8Array.from(
      atob(
        (await hmacBase64url(new TextEncoder().encode(SECRET), 'marcapony-end-user-v1'))
          .replace(/-/g, '+')
          .replace(/_/g, '/'),
      ),
      (c) => c.charCodeAt(0),
    )
    expect(signature).toBe(await hmacBase64url(cookieKey, id))
    expect(calls[0]?.body).toEqual({ endUser: id, endUserIp: '203.0.113.9', locale: 'tr' })
  })

  it('keeps a valid cookie and replaces a forged one', async () => {
    const { handler, calls } = setup([started, started, started])
    const first = await handler(post(`${APP}/api/chat/barista/conversations`, {}))
    const value = cookieValue(first)
    const id = value.split('.')[0]

    const again = await handler(
      post(
        `${APP}/api/chat/barista/conversations`,
        {},
        { Cookie: `other=1; ${END_USER_COOKIE}=${value}` },
      ),
    )
    expect(again.headers.get('Set-Cookie')).toBeNull()
    expect((calls[1]!.body as { endUser: string }).endUser).toBe(id!)

    const forged = await handler(
      post(
        `${APP}/api/chat/barista/conversations`,
        {},
        {
          Cookie: `${END_USER_COOKIE}=${id}.${'A'.repeat(43)}`,
        },
      ),
    )
    expect(forged.headers.get('Set-Cookie')).not.toBeNull()
    expect((calls[2]!.body as { endUser: string }).endUser).not.toBe(id!)
  })

  it('gives way to the app’s own end-user id', async () => {
    const { handler, calls } = setup([started], { endUser: () => 'member-42' })
    const response = await handler(post(`${APP}/api/chat/barista/conversations`, {}))
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect((calls[0]!.body as { endUser: string }).endUser).toBe('member-42')
  })
})

describe('routing', () => {
  it('answers 404 for a character outside the allow-list and for unknown paths', async () => {
    const { handler, calls } = setup([], { personas: ['barista'] })
    expect((await handler(new Request(`${APP}/api/chat/wizard`))).status).toBe(404)
    expect((await handler(new Request(`${APP}/api/chat/barista/other`))).status).toBe(404)
    expect((await handler(post(`${ROUTE}/verify`, {}))).status).toBe(404)
    expect((await handler(new Request(`${ROUTE}/messages`))).status).toBe(405)
    expect(calls).toHaveLength(0)
  })

  it('reads one character', async () => {
    const { handler, calls } = setup([
      () => jsonResponse({ data: { slug: 'barista', name: 'Barista', available: true } }),
    ])
    const response = await handler(new Request(`${APP}/api/chat/barista?locale=en`))
    expect(await response.json()).toMatchObject({ slug: 'barista' })
    expect(calls[0]?.url).toBe(`${BASE}/personas/barista?locale=en`)
  })
})

describe('messages', () => {
  const history = [
    { role: 'user', text: 'Hi', messageId: 'u0', signature: 'sig-u0' },
    { role: 'assistant', text: 'Hello!', messageId: 'a0', signature: 'sig-a0' },
  ]

  it('forwards the browser history untouched and returns the signed list', async () => {
    const { handler, calls } = setup([reply])
    const response = await handler(post(`${ROUTE}/messages`, { text: 'Coffee?', history }))
    expect(calls[0]?.body).toEqual({ text: 'Coffee?', history })
    const body = (await response.json()) as { text: string; history: unknown[] }
    expect(body.text).toBe('An espresso.')
    expect(body.history).toEqual([
      ...history,
      { role: 'user', text: 'Coffee?', messageId: 'u1', signature: 'sig-u1' },
      { role: 'assistant', text: 'An espresso.', messageId: 'a1', signature: 'sig-a1' },
    ])
  })

  it('streams the answer through, with the history on done', async () => {
    const frames = [
      { type: 'message_start', messageId: 'a1' },
      { type: 'text', content: 'An espresso.' },
      {
        type: 'done',
        messageId: 'a1',
        turn: 1,
        signature: 'sig-a1',
        userMessageId: 'u1',
        userSignature: 'sig-u1',
      },
    ]
    const { handler, calls } = setup([
      () =>
        new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    ])
    const response = await handler(
      post(`${ROUTE}/messages`, { text: 'Coffee?' }, { Accept: 'text/event-stream' }),
    )
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    expect(calls[0]?.headers.Accept).toBe('text/event-stream')
    const events = (await response.text())
      .split('\n\n')
      .filter(Boolean)
      .map(
        (line) => JSON.parse(line.slice('data: '.length)) as { type: string; history?: unknown[] },
      )
    expect(events.map((e) => e.type)).toEqual(['message_start', 'text', 'done'])
    expect(events[2]?.history).toHaveLength(2)
  })

  it('passes a refusal through with its status and code', async () => {
    const { handler } = setup([
      () => jsonResponse({ error: { code: 'persona_daily_cap', message: 'Resting today' } }, 429),
    ])
    const response = await handler(post(`${ROUTE}/messages`, { text: 'Hi' }))
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ code: 'persona_daily_cap', error: 'Resting today' })
  })

  it('refuses an empty or overlong message before calling Marcapony', async () => {
    const { handler, calls } = setup([])
    expect((await handler(post(`${ROUTE}/messages`, { text: '   ' }))).status).toBe(400)
    expect((await handler(post(`${ROUTE}/messages`, { text: 'x'.repeat(2001) }))).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('reports a message', async () => {
    const { handler, calls } = setup([() => jsonResponse({ data: { reported: true } }, 201)])
    const response = await handler(post(`${ROUTE}/reports`, { messageId: 'a1', reason: 'unsafe' }))
    expect(response.status).toBe(201)
    expect(calls[0]?.body).toEqual({ messageId: 'a1', reason: 'unsafe' })
    expect(
      (await handler(post(`${ROUTE}/reports`, { messageId: 'a1', reason: 'bad' }))).status,
    ).toBe(400)
  })
})

describe('Turnstile mode', () => {
  const turnstile = { siteKey: 'site-key', secretKey: 'secret-key' }
  const needsCheck = () =>
    jsonResponse({ error: { code: 'verification_required', message: 'Verify first' } }, 401)
  const siteverify = (success: boolean) => () => jsonResponse({ success })

  it('starts conversations that require a check', async () => {
    const { handler, calls } = setup([started], { turnstile })
    const response = await handler(post(`${APP}/api/chat/barista/conversations`, {}))
    expect((calls[0]!.body as { requireVerification: boolean }).requireVerification).toBe(true)
    expect(await response.json()).toMatchObject({ turnstileSiteKey: 'site-key' })
  })

  it('asks the browser for a token when none was sent', async () => {
    const { handler } = setup([needsCheck], { turnstile })
    const response = await handler(post(`${ROUTE}/messages`, { text: 'Hi' }))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      code: 'verification_required',
      turnstileSiteKey: 'site-key',
    })
  })

  it('checks the token, verifies the conversation and sends the message once more', async () => {
    const { handler, calls } = setup(
      [
        needsCheck,
        siteverify(true),
        () => jsonResponse({ data: { verified: true, turn: 0 } }),
        reply,
      ],
      { turnstile },
    )
    const response = await handler(
      post(
        `${ROUTE}/messages`,
        { text: 'Hi', turnstileToken: 'token-1' },
        {
          'cf-connecting-ip': '203.0.113.9',
        },
      ),
    )
    expect(response.status).toBe(200)
    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}/personas/barista/conversations/${CONVERSATION}/messages`,
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      `${BASE}/personas/barista/conversations/${CONVERSATION}/verify`,
      `${BASE}/personas/barista/conversations/${CONVERSATION}/messages`,
    ])
    expect(calls[1]?.body).toEqual({
      secret: 'secret-key',
      response: 'token-1',
      remoteip: '203.0.113.9',
    })
  })

  it('does the same before a stream opens', async () => {
    const { handler, calls } = setup(
      [
        needsCheck,
        siteverify(true),
        () => jsonResponse({ data: { verified: true, turn: 0 } }),
        () =>
          new Response(
            `data: ${JSON.stringify({ type: 'message_start', messageId: 'a1' })}\n\ndata: ${JSON.stringify({ type: 'done', messageId: 'a1', turn: 1 })}\n\n`,
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      ],
      { turnstile },
    )
    const response = await handler(
      post(
        `${ROUTE}/messages`,
        { text: 'Hi', turnstileToken: 't' },
        { Accept: 'text/event-stream' },
      ),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"type":"done"')
    expect(calls).toHaveLength(4)
  })

  it('does not verify the conversation when the token fails', async () => {
    const { handler, calls } = setup([needsCheck, siteverify(false)], { turnstile })
    const response = await handler(post(`${ROUTE}/messages`, { text: 'Hi', turnstileToken: 'bad' }))
    expect(response.status).toBe(401)
    expect(calls).toHaveLength(2)
  })
})
