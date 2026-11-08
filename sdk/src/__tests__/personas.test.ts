import { describe, expect, it } from 'bun:test'
import {
  createClient,
  PersonaLimitError,
  PersonaUnavailableError,
  RateLimitError,
  ServerError,
  ValidationError,
  VerificationRequiredError,
  type PersonaEvent,
  type PersonaHistoryEntry,
} from '../index'
import { extendHistory } from '../resources/personas'
import { SseParser } from '../transport'

const BASE = 'https://x.test/ext/v1'
const CONVERSATION = '4f6c2a9e-1b3d-4c5e-8f70-123456789abc'

type Call = { url: string; init: RequestInit; body: unknown }

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

/** A streamed answer, cut into the given chunks. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`

function makeFetch(responses: Array<Response | (() => Response | Promise<Response>)>) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const next = responses.shift()
    if (!next) throw new Error('unexpected extra request')
    return typeof next === 'function' ? next() : next
  }) as typeof globalThis.fetch
  return { fetch: fetchImpl, calls }
}

function client(fetchImpl: typeof globalThis.fetch, timeoutMs?: number) {
  return createClient({ apiKey: 'mpk_test', baseUrl: BASE, fetch: fetchImpl, timeoutMs })
}

const headers = (call: Call | undefined) => (call?.init.headers ?? {}) as Record<string, string>

const started = (storesTranscripts = false, testMode = false) =>
  jsonResponse(
    {
      data: {
        conversationId: CONVERSATION,
        channel: 'app',
        storesTranscripts,
        ...(testMode ? { testMode: true } : {}),
      },
    },
    201,
  )

const reply = (overrides: object = {}) =>
  jsonResponse({
    data: {
      messageId: 'a1',
      text: 'An espresso.',
      signature: 'sig-a1',
      userMessageId: 'u1',
      userSignature: 'sig-u1',
      turn: 1,
      ...overrides,
    },
  })

describe('personas.list and get', () => {
  it('read the granted characters from the base client, without an identity header', async () => {
    const summary = {
      slug: 'barista',
      name: 'Barista',
      description: '',
      avatarUrl: null,
      greeting: 'Hi',
      starterQuestions: [],
      available: true,
    }
    const { fetch, calls } = makeFetch([
      jsonResponse({ data: [summary] }),
      jsonResponse({ data: summary }),
    ])
    const mp = client(fetch)
    expect(await mp.personas.list({ locale: 'en' })).toEqual([summary])
    expect(await mp.personas.get('barista')).toEqual(summary)
    expect(calls[0]?.url).toBe(`${BASE}/personas?locale=en`)
    expect(calls[1]?.url).toBe(`${BASE}/personas/barista`)
    expect(headers(calls[0])['x-marcapony-identity']).toBeUndefined()
  })
})

describe('personas.start', () => {
  it('posts the options and returns a chat', async () => {
    const { fetch, calls } = makeFetch([started(false, true)])
    const chat = await client(fetch).personas.start('barista', {
      endUser: 'player-1',
      endUserIp: '203.0.113.9',
      locale: 'tr',
      metadata: { level: '3' },
      requireVerification: true,
      idempotencyKey: 'start-1',
    })
    expect(calls[0]?.url).toBe(`${BASE}/personas/barista/conversations`)
    expect(calls[0]?.body).toEqual({
      endUser: 'player-1',
      endUserIp: '203.0.113.9',
      locale: 'tr',
      metadata: { level: '3' },
      requireVerification: true,
    })
    expect(headers(calls[0])['Idempotency-Key']).toBe('start-1')
    expect(chat.id).toBe(CONVERSATION)
    expect(chat.slug).toBe('barista')
    expect(chat.storesTranscripts).toBe(false)
    expect(chat.testMode).toBe(true)
    expect(chat.history).toEqual([])
  })
})

describe('chat.send', () => {
  it('sends the history and extends it with the signed turn', async () => {
    const { fetch, calls } = makeFetch([
      started(),
      reply(),
      reply({
        messageId: 'a2',
        userMessageId: 'u2',
        userSignature: 'sig-u2',
        signature: 'sig-a2',
        turn: 2,
      }),
    ])
    const chat = await client(fetch).personas.start('barista')
    const first = await chat.send('  What do you recommend?  ')
    expect(first).toEqual({ messageId: 'a1', text: 'An espresso.', turn: 1, testMode: false })
    expect(calls[1]?.url).toBe(`${BASE}/personas/barista/conversations/${CONVERSATION}/messages`)
    expect(calls[1]?.body).toEqual({ text: '  What do you recommend?  ', history: [] })
    expect(headers(calls[1]).Accept).toBe('application/json')

    const expected: PersonaHistoryEntry[] = [
      { role: 'user', text: 'What do you recommend?', messageId: 'u1', signature: 'sig-u1' },
      { role: 'assistant', text: 'An espresso.', messageId: 'a1', signature: 'sig-a1' },
    ]
    expect(chat.history).toEqual(expected)
    await chat.send('And a dessert?')
    expect((calls[2]!.body as { history: unknown }).history).toEqual(expected)
    expect(chat.history).toHaveLength(4)
  })

  it('leaves out a visitor message that came back without a signature', async () => {
    const { fetch } = makeFetch([
      started(),
      reply({ userMessageId: undefined, userSignature: undefined }),
    ])
    const chat = await client(fetch).personas.start('barista')
    await chat.send('something refused')
    expect(chat.history.map((entry) => entry.role)).toEqual(['assistant'])
  })

  it('sends no history when the transcript is kept', async () => {
    const { fetch, calls } = makeFetch([
      started(true),
      reply({ signature: undefined, userMessageId: undefined, userSignature: undefined }),
    ])
    const chat = await client(fetch).personas.start('barista')
    await chat.send('Hello')
    expect(calls[1]?.body).toEqual({ text: 'Hello' })
    expect(chat.history).toEqual([])
  })

  it('is never retried, not even on a 503 or a network failure', async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ error: { code: 'service_unavailable', message: 'later' } }, 503),
      () => {
        throw new TypeError('network down')
      },
    ])
    const chat = client(fetch).personas.resume('barista', CONVERSATION)
    expect(await chat.send('a').catch((e: unknown) => e)).toBeInstanceOf(ServerError)
    expect(calls).toHaveLength(1)
    expect(await chat.send('b').catch((e: unknown) => e)).toBeInstanceOf(ServerError)
    expect(calls).toHaveLength(2)
  })

  it('waits longer than the client timeout for an answer', async () => {
    const slow = () => new Promise<Response>((resolve) => setTimeout(() => resolve(reply()), 60))
    const { fetch } = makeFetch([slow])
    const chat = client(fetch, 10).personas.resume('barista', CONVERSATION)
    expect((await chat.send('Hello')).text).toBe('An espresso.')
  })

  it('refuses a second message while one is running', async () => {
    let release: (response: Response) => void = () => undefined
    const { fetch } = makeFetch([() => new Promise<Response>((resolve) => (release = resolve))])
    const chat = client(fetch).personas.resume('barista', CONVERSATION)
    const first = chat.send('one')
    await expect(chat.send('two')).rejects.toThrow('still running')
    release(reply())
    await first
  })

  it('throws the typed errors of the character routes', async () => {
    const cases: Array<[number, string, new (...args: never[]) => Error]> = [
      [403, 'persona_unavailable', PersonaUnavailableError],
      [503, 'feature_paused', PersonaUnavailableError],
      [429, 'persona_daily_cap', PersonaLimitError],
      [429, 'app_daily_cap', PersonaLimitError],
      [429, 'test_mode_daily_cap', PersonaLimitError],
      [503, 'beta_budget_reached', PersonaLimitError],
      [401, 'verification_required', VerificationRequiredError],
      [422, 'invalid_history', ValidationError],
      [429, 'rate_limited', RateLimitError],
    ]
    for (const [status, code, ErrorClass] of cases) {
      const { fetch } = makeFetch([jsonResponse({ error: { code, message: 'no' } }, status)])
      const err = await client(fetch)
        .personas.resume('barista', CONVERSATION)
        .send('x')
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ErrorClass)
      expect((err as { code: string }).code).toBe(code)
    }
  })
})

describe('a refused history', () => {
  const refused = () =>
    jsonResponse({ error: { code: 'invalid_history', message: 'history refused' } }, 422)
  const NEW_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
  const restarted = () =>
    jsonResponse(
      { data: { conversationId: NEW_ID, channel: 'app', storesTranscripts: false } },
      201,
    )

  it('starts a chat from start over in a new conversation and sends the message there', async () => {
    const { fetch, calls } = makeFetch([started(), reply(), refused(), restarted(), reply()])
    const chat = await client(fetch).personas.start('barista', {
      endUser: 'p1',
      requireVerification: true,
      idempotencyKey: 'start-1',
    })
    await chat.send('first')
    expect(chat.history).toHaveLength(2)
    const answer = await chat.send('second')
    expect(answer.text).toBe('An espresso.')
    expect(chat.id).toBe(NEW_ID)
    expect(calls[3]?.url).toBe(`${BASE}/personas/barista/conversations`)
    expect(calls[3]?.body).toEqual({ endUser: 'p1', requireVerification: true })
    expect(headers(calls[3])['Idempotency-Key']).toBeUndefined()
    expect(calls[4]?.url).toBe(`${BASE}/personas/barista/conversations/${NEW_ID}/messages`)
    expect(calls[4]?.body).toEqual({ text: 'second', endUser: 'p1', history: [] })
    expect(chat.history.map((entry) => entry.text)).toEqual(['second', 'An espresso.'])
  })

  it('does the same before a stream opens', async () => {
    const { fetch, calls } = makeFetch([
      started(),
      refused(),
      restarted(),
      sseResponse([
        frame({ type: 'message_start', messageId: 'a1' }) +
          frame({ type: 'text', content: 'Hello' }) +
          frame({ type: 'done', messageId: 'a1', turn: 1, signature: 'sig-a1' }),
      ]),
    ])
    const chat = await client(fetch).personas.start('barista')
    const events = await collect(chat.stream('Hi'))
    expect(events.map((event) => event.type)).toEqual(['message_start', 'text', 'done'])
    expect(chat.id).toBe(NEW_ID)
    expect(calls).toHaveLength(4)
  })

  it('is thrown by a resumed chat, which cannot know how it was started', async () => {
    const { fetch, calls } = makeFetch([refused()])
    const chat = client(fetch).personas.resume('barista', CONVERSATION)
    const err = await chat.send('x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as { code: string }).code).toBe('invalid_history')
    expect(calls).toHaveLength(1)
  })
})

describe('cap errors', () => {
  it('are never retried, even where a request would be', async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ error: { code: 'persona_daily_cap', message: 'spent' } }, 429),
      jsonResponse({ error: { code: 'feature_paused', message: 'paused' } }, 503),
    ])
    const mp = client(fetch)
    expect(await mp.personas.get('barista').catch((e: unknown) => e)).toBeInstanceOf(
      PersonaLimitError,
    )
    expect(calls).toHaveLength(1)
    expect(await mp.personas.list().catch((e: unknown) => e)).toBeInstanceOf(
      PersonaUnavailableError,
    )
    expect(calls).toHaveLength(2)
  })

  it('leave the retry of an ordinary 429 as it was', async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ error: { code: 'rate_limited', message: 'slow' } }, 429, {
        'Retry-After': '0',
      }),
      jsonResponse({ data: [] }),
    ])
    expect(await client(fetch).personas.list()).toEqual([])
    expect(calls).toHaveLength(2)
  })
})

async function collect(events: AsyncIterable<PersonaEvent>): Promise<PersonaEvent[]> {
  const out: PersonaEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('chat.stream', () => {
  it('yields the events, split anywhere, and extends the history on done', async () => {
    const body =
      frame({ type: 'message_start', messageId: 'a1' }) +
      frame({ type: 'text', content: 'Café ' }) +
      frame({ type: 'tool_call', id: 't1', name: 'products', args: {} }) +
      frame({ type: 'tool_result', id: 't1', name: 'products', success: true }) +
      frame({ type: 'text', content: 'au lait.' }) +
      frame({
        type: 'done',
        messageId: 'a1',
        turn: 1,
        signature: 'sig-a1',
        userMessageId: 'u1',
        userSignature: 'sig-u1',
      })
    // Cut mid-frame and mid-character (é is two bytes in UTF-8).
    const bytes = new TextEncoder().encode(body)
    const cut = body.indexOf('é') + 1
    const chunks = [bytes.slice(0, cut), bytes.slice(cut, cut + 7), bytes.slice(cut + 7)]
    const { fetch, calls } = makeFetch([
      started(),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk)
              controller.close()
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    ])
    const chat = await client(fetch).personas.start('barista')
    const events = await collect(chat.stream('Hello'))
    expect(events.map((event) => event.type)).toEqual([
      'message_start',
      'text',
      'tool_call',
      'tool_result',
      'text',
      'done',
    ])
    expect(headers(calls[1]).Accept).toBe('text/event-stream')
    expect(chat.history).toEqual([
      { role: 'user', text: 'Hello', messageId: 'u1', signature: 'sig-u1' },
      { role: 'assistant', text: 'Café au lait.', messageId: 'a1', signature: 'sig-a1' },
    ])
  })

  it('signs the replacement after a retraction, not the withdrawn text', async () => {
    const { fetch } = makeFetch([
      sseResponse([
        frame({ type: 'message_start', messageId: 'a1' }) +
          frame({ type: 'text', content: 'Something bad' }) +
          frame({ type: 'retract', messageId: 'a1' }) +
          frame({ type: 'message_start', messageId: 'a2' }) +
          frame({ type: 'text', content: 'I cannot help with that.' }) +
          frame({ type: 'done', messageId: 'a2', turn: 1, signature: 'sig-a2' }),
      ]),
    ])
    const chat = client(fetch).personas.resume('barista', CONVERSATION)
    await collect(chat.stream('x'))
    expect(chat.history).toEqual([
      { role: 'assistant', text: 'I cannot help with that.', messageId: 'a2', signature: 'sig-a2' },
    ])
  })

  it('throws an error frame as its typed error', async () => {
    const { fetch } = makeFetch([
      sseResponse([
        frame({ type: 'message_start', messageId: 'a1' }) +
          frame({ type: 'error', code: 'persona_unavailable', error: 'resting' }),
      ]),
    ])
    const chat = client(fetch).personas.resume('barista', CONVERSATION)
    const err = await collect(chat.stream('x')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PersonaUnavailableError)
    expect(chat.history).toEqual([])
  })

  it('keeps nothing of a turn that failed after some text', async () => {
    const { fetch } = makeFetch([
      sseResponse([
        frame({ type: 'message_start', messageId: 'a1' }) +
          frame({ type: 'text', content: 'Half an ans' }) +
          frame({ type: 'error', code: 'server_error', error: 'Something went wrong' }) +
          // Never sent after an error; ignored even if it were.
          frame({ type: 'done', messageId: 'a1', turn: 1, signature: 'sig-a1' }),
      ]),
      jsonResponse({ error: { code: 'server_error', message: 'No answer' } }, 500),
    ])
    const chat = client(fetch).personas.resume('barista', CONVERSATION)
    const seen: string[] = []
    const err = await (async () => {
      for await (const event of chat.stream('x')) seen.push(event.type)
    })().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServerError)
    expect(seen).toEqual(['message_start', 'text'])
    expect(chat.history).toEqual([])
    expect(await chat.send('y').catch((e: unknown) => e)).toBeInstanceOf(ServerError)
    expect(chat.history).toEqual([])
  })

  it('throws a refusal before the stream as its typed error, once', async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ error: { code: 'conversation_limit_reached', message: 'enough' } }, 429),
    ])
    const chat = client(fetch).personas.resume('barista', CONVERSATION)
    const err = await collect(chat.stream('x')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PersonaLimitError)
    expect(calls).toHaveLength(1)
  })

  it('throws when the stream ends without done, and is not retried', async () => {
    const { fetch, calls } = makeFetch([
      sseResponse([frame({ type: 'message_start', messageId: 'a1' })]),
    ])
    const chat = client(fetch).personas.resume('barista', CONVERSATION)
    const err = await collect(chat.stream('x')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServerError)
    expect(calls).toHaveLength(1)
  })

  it('outlives the client timeout and ends at the caller abort', async () => {
    const controller = new AbortController()
    const { fetch } = makeFetch([
      (() => {
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(encoder.encode(frame({ type: 'message_start', messageId: 'a1' })))
              setTimeout(
                () => stream.enqueue(encoder.encode(frame({ type: 'text', content: 'late' }))),
                40,
              )
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      })(),
    ])
    const chat = client(fetch, 10).personas.resume('barista', CONVERSATION)
    const seen: string[] = []
    for await (const event of chat.stream('x', { signal: controller.signal })) {
      seen.push(event.type)
      if (event.type === 'text') break
    }
    expect(seen).toEqual(['message_start', 'text'])
  })
})

describe('the other chat calls', () => {
  it('report, verify and read the transcript of the conversation', async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ data: { reported: true } }, 201),
      jsonResponse({ data: { verified: true, turn: 0 } }),
      jsonResponse({
        data: [{ messageId: 'm1', role: 'user', text: 'Hi', createdAt: '2026-01-01T00:00:00Z' }],
      }),
    ])
    const chat = client(fetch).personas.resume('barista', CONVERSATION)
    await chat.report('a1', 'wrong', { note: 'not on the menu' })
    await chat.verify()
    expect(await chat.transcript()).toHaveLength(1)
    const route = `${BASE}/personas/barista/conversations/${CONVERSATION}`
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ['POST', `${route}/reports`],
      ['POST', `${route}/verify`],
      ['GET', `${route}/messages`],
    ])
    expect(calls[0]?.body).toEqual({ messageId: 'a1', reason: 'wrong', note: 'not on the menu' })
  })

  it('name the end user the conversation was started with on every call', async () => {
    const { fetch, calls } = makeFetch([
      started(),
      reply(),
      jsonResponse({ data: { reported: true } }, 201),
      jsonResponse({ data: { verified: true, turn: 1 } }),
      jsonResponse({ data: [] }),
    ])
    const chat = await client(fetch).personas.start('barista', { endUser: 'player 1' })
    expect(chat.endUser).toBe('player 1')
    await chat.send('Hi')
    await chat.report('a1', 'other')
    await chat.verify()
    await chat.transcript()
    expect((calls[1]!.body as { endUser: string }).endUser).toBe('player 1')
    expect((calls[2]!.body as { endUser: string }).endUser).toBe('player 1')
    expect(calls[3]?.body).toEqual({ endUser: 'player 1' })
    expect(calls[4]?.url).toBe(
      `${BASE}/personas/barista/conversations/${CONVERSATION}/messages?endUser=player+1`,
    )
  })

  it('send no end user for a conversation started without one', async () => {
    const { fetch, calls } = makeFetch([reply()])
    await client(fetch).personas.resume('barista', CONVERSATION).send('Hi')
    expect(calls[0]?.body).toEqual({ text: 'Hi', history: [] })
  })

  it('resume makes no request and refuses an id that would leave its path segment', () => {
    const { fetch, calls } = makeFetch([])
    const mp = client(fetch)
    mp.personas.resume('barista', CONVERSATION)
    expect(calls).toHaveLength(0)
    expect(() => mp.personas.resume('barista', '..')).toThrow('invalid record id')
  })
})

describe('extendHistory', () => {
  const entry = (i: number, text = `m${i}`): PersonaHistoryEntry => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    text,
    messageId: `id${i}`,
    signature: `s${i}`,
  })

  it('keeps the newest 30 entries', () => {
    const history = Array.from({ length: 30 }, (_, i) => entry(i))
    const next = extendHistory(history, [entry(30), entry(31)])
    expect(next).toHaveLength(30)
    expect(next[0]?.messageId).toBe('id2')
    expect(next[29]?.messageId).toBe('id31')
  })

  it('keeps long signed answers up to 32,768 characters', () => {
    const next = extendHistory([], [entry(0), entry(1, 'x'.repeat(32_768))])
    expect(next.map((e) => e.messageId)).toEqual(['id0', 'id1'])
  })

  it('leaves out entries over their limit, which a signature cannot shorten', () => {
    const next = extendHistory(
      [],
      [entry(0, 'x'.repeat(2001)), entry(1, 'x'.repeat(32_769)), entry(2), entry(3)],
    )
    expect(next.map((e) => e.messageId)).toEqual(['id2', 'id3'])
  })
})

describe('SseParser', () => {
  it('reads data lines, skips comments and frames that are not JSON, and accepts CRLF', () => {
    const parser = new SseParser()
    const encoder = new TextEncoder()
    expect(
      parser.push(encoder.encode(': keep-alive\n\ndata: {"a":1}\r\n\r\ndata: nope\n\ndata:')),
    ).toEqual([{ a: 1 }])
    expect(parser.push(encoder.encode('{"b":2}\n\n'))).toEqual([{ b: 2 }])
    expect(parser.flush()).toEqual([])
  })
})
