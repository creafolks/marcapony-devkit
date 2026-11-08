import type { MarcaponyClient } from './client.js'
import { MarcaponyError, VerificationRequiredError } from './errors.js'
import type { PersonaChat } from './resources/personas.js'
import type { PersonaEvent, PersonaHistoryEntry, PersonaReportReason } from './types/index.js'

/** The cookie that keeps a visitor's anonymous id. */
export const END_USER_COOKIE = 'mp_eu'
/** The cookie key is derived from the app secret under this label, so the secret can sign other things later. */
const COOKIE_KEY_LABEL = 'marcapony-end-user-v1'
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60
const END_USER_ID_BYTES = 16
const MIN_SECRET_LENGTH = 32
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const MAX_TEXT_CHARS = 2000

const SLUG = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const END_USER_ID = /^[A-Za-z0-9_-]{22}$/
const REPORT_REASONS: readonly PersonaReportReason[] = ['unsafe', 'wrong', 'other']

export interface TurnstileOptions {
  /** The widget's site key, handed to the browser when a check is needed. */
  siteKey: string
  /** The widget's secret key. Keep it in an environment value, never in the bundle. */
  secretKey: string
}

export interface PersonasHandlerOptions {
  /**
   * Signs the visitor cookie: `env.MARCAPONY_APP_SECRET`, which Marcapony sets
   * for every environment of an app that a character is granted to. At least
   * 32 characters.
   */
  secret: string
  /** Where the handler is mounted. Default `/api/chat`. */
  basePath?: string
  /** The character slugs the browser may address. Default: every character granted to the app. */
  personas?: readonly string[]
  /**
   * Your own id for the visitor, for apps with their own sign-in. Return null
   * to fall back to the anonymous cookie.
   */
  endUser?: (request: Request) => string | null | undefined | Promise<string | null | undefined>
  /**
   * Requires a Turnstile check on the first message of a conversation and
   * after every 10 messages, with your own widget.
   */
  turnstile?: TurnstileOptions
  /** Custom fetch for the Turnstile check (tests). Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch
}

type Route =
  | { kind: 'persona'; slug: string }
  | { kind: 'start'; slug: string }
  | { kind: 'message'; slug: string; id: string }
  | { kind: 'report'; slug: string; id: string }
  | { kind: 'verify'; slug: string; id: string }

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)))
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

/** The signed visitor id: `<id>.<signature>`, the id 16 random bytes. */
export function createEndUserCookies(secret: string) {
  const cookieKey = hmac(encoder.encode(secret), COOKIE_KEY_LABEL)
  const sign = async (id: string) => base64url(await hmac(await cookieKey, id))

  return {
    /** The id in a valid cookie, or null for a missing or forged one. */
    async read(request: Request): Promise<string | null> {
      const value = readCookie(request, END_USER_COOKIE)
      if (!value) return null
      const dot = value.indexOf('.')
      const id = value.slice(0, dot)
      if (dot < 0 || !END_USER_ID.test(id)) return null
      return safeEqual(value.slice(dot + 1), await sign(id)) ? id : null
    },
    /** A new id and the `Set-Cookie` header that stores it. */
    async issue(): Promise<{ id: string; setCookie: string }> {
      const id = base64url(crypto.getRandomValues(new Uint8Array(END_USER_ID_BYTES)))
      const value = `${id}.${await sign(id)}`
      return {
        id,
        setCookie: `${END_USER_COOKIE}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
      }
    },
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

function refuse(status: number, code: string, error: string, extra: object = {}): Response {
  return json({ code, error, ...extra }, status)
}

/** The server's own message, without the request line the SDK puts in front for logs. */
function publicMessage(err: MarcaponyError): string {
  return err.message.replace(/^[A-Z]+ \S+ → \d+ \S+: /, '')
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * A ready request handler for the app's own chat route, so the browser talks
 * to a character without ever seeing the app key:
 *
 * ```ts
 * const chat = personasHandler(mp, { secret: env.MARCAPONY_APP_SECRET })
 * app.all('/api/chat/*', (c) => chat(c.req.raw))
 * ```
 *
 * Routes below `basePath`: `GET /:slug`, `POST /:slug/conversations`,
 * `POST /:slug/conversations/:id/messages` (streams when the browser accepts
 * `text/event-stream`), `POST /:slug/conversations/:id/reports` and, with
 * Turnstile, `POST /:slug/conversations/:id/verify`.
 *
 * Every visitor gets an anonymous id in the `mp_eu` cookie (HttpOnly, Secure,
 * SameSite=Lax, one year), signed with `secret`; a missing or forged cookie
 * gets a new id. The handler stores nothing: the browser keeps the signed
 * history it returns and sends it back with the next message.
 */
export function personasHandler(
  mp: Pick<MarcaponyClient, 'personas'>,
  options: PersonasHandlerOptions,
): (request: Request) => Promise<Response> {
  if (typeof options.secret !== 'string' || options.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `marcapony-sdk: personasHandler needs a secret of at least ${MIN_SECRET_LENGTH} characters. Pass secret: env.MARCAPONY_APP_SECRET.`,
    )
  }
  const basePath = (options.basePath ?? '/api/chat').replace(/\/+$/, '')
  const allowed = options.personas ? new Set(options.personas) : null
  const cookies = createEndUserCookies(options.secret)
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const turnstile = options.turnstile ?? null

  function route(request: Request): Route | 'not_found' | 'method_not_allowed' {
    const pathname = new URL(request.url).pathname
    if (!pathname.startsWith(`${basePath}/`)) return 'not_found'
    const parts = pathname.slice(basePath.length + 1).split('/')
    const [slug, collection, id, action] = parts
    if (!slug || !SLUG.test(slug) || (allowed && !allowed.has(slug))) return 'not_found'
    const method = request.method
    if (parts.length === 1)
      return method === 'GET' ? { kind: 'persona', slug } : 'method_not_allowed'
    if (collection !== 'conversations') return 'not_found'
    if (parts.length === 2)
      return method === 'POST' ? { kind: 'start', slug } : 'method_not_allowed'
    if (!id || !CONVERSATION_ID.test(id) || parts.length !== 4) return 'not_found'
    const kind =
      action === 'messages'
        ? 'message'
        : action === 'reports'
          ? 'report'
          : action === 'verify' && turnstile
            ? 'verify'
            : null
    if (!kind) return 'not_found'
    return method === 'POST' ? { kind, slug, id } : 'method_not_allowed'
  }

  async function passesTurnstile(token: unknown, request: Request): Promise<boolean> {
    if (!turnstile || typeof token !== 'string' || token.length === 0 || token.length > 2048) {
      return false
    }
    const form = new FormData()
    form.set('secret', turnstile.secretKey)
    form.set('response', token)
    const ip = request.headers.get('cf-connecting-ip')
    if (ip) form.set('remoteip', ip)
    try {
      const response = await fetchImpl(TURNSTILE_VERIFY_URL, { method: 'POST', body: form })
      const result = (await response.json()) as { success?: unknown }
      return result.success === true
    } catch {
      return false
    }
  }

  function verificationNeeded(message: string): Response {
    return refuse(401, 'verification_required', message, {
      ...(turnstile ? { turnstileSiteKey: turnstile.siteKey } : {}),
    })
  }

  /** Runs a turn; on a requested bot check, checks the browser's token, tells Marcapony and tries once more. */
  async function withVerification<T>(
    chat: PersonaChat,
    token: unknown,
    request: Request,
    turn: () => Promise<T>,
  ): Promise<T | Response> {
    try {
      return await turn()
    } catch (err) {
      if (!(err instanceof VerificationRequiredError) || !turnstile) throw err
      if (token === undefined) return verificationNeeded('Complete the check to continue')
      if (!(await passesTurnstile(token, request))) {
        return verificationNeeded('The check did not pass; try again')
      }
      await chat.verify()
      return await turn()
    }
  }

  async function start(request: Request, slug: string): Promise<Response> {
    const body = (await readBody(request)) ?? {}
    const own = await options.endUser?.(request)
    let endUser = typeof own === 'string' && own.length > 0 ? own : null
    let setCookie: string | null = null
    if (endUser === null) {
      endUser = await cookies.read(request)
      if (endUser === null) {
        const issued = await cookies.issue()
        endUser = issued.id
        setCookie = issued.setCookie
      }
    }
    const ip = request.headers.get('cf-connecting-ip')
    const chat = await mp.personas.start(slug, {
      endUser,
      ...(ip ? { endUserIp: ip } : {}),
      ...(typeof body.locale === 'string' ? { locale: body.locale } : {}),
      ...(turnstile ? { requireVerification: true } : {}),
    })
    return json(
      {
        conversationId: chat.id,
        storesTranscripts: chat.storesTranscripts === true,
        testMode: chat.testMode,
        ...(turnstile ? { turnstileSiteKey: turnstile.siteKey } : {}),
      },
      201,
      setCookie ? { 'Set-Cookie': setCookie } : {},
    )
  }

  async function message(request: Request, slug: string, id: string): Promise<Response> {
    const body = await readBody(request)
    const text = typeof body?.text === 'string' ? body.text : ''
    if (text.trim().length === 0 || text.length > MAX_TEXT_CHARS) {
      return refuse(
        400,
        'validation_failed',
        `Write a message of 1 to ${MAX_TEXT_CHARS} characters`,
      )
    }
    // The browser's history goes to Marcapony untouched; it checks every signature.
    const history = Array.isArray(body?.history) ? (body.history as PersonaHistoryEntry[]) : []
    const chat = mp.personas.resume(slug, id, { history })
    const token = body?.turnstileToken

    if (!(request.headers.get('Accept') ?? '').includes('text/event-stream')) {
      const reply = await withVerification(chat, token, request, () => chat.send(text))
      if (reply instanceof Response) return reply
      return json({ ...reply, history: chat.history })
    }

    let iterator: AsyncIterator<PersonaEvent> | null = null
    const first = await withVerification(chat, token, request, async () => {
      iterator = chat.stream(text)[Symbol.asyncIterator]()
      return iterator.next()
    })
    if (first instanceof Response) return first
    const events = iterator as unknown as AsyncIterator<PersonaEvent>
    let pending: IteratorResult<PersonaEvent> | null = first
    const frame = (event: object) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = pending ?? (await events.next())
          pending = null
          if (next.done) {
            controller.close()
            return
          }
          const event = next.value
          // The browser keeps the history: hand it the signed list with the end of the answer.
          controller.enqueue(
            frame(event.type === 'done' ? { ...event, history: chat.history } : event),
          )
        } catch (err) {
          const code = err instanceof MarcaponyError ? err.code : 'server_error'
          const error =
            err instanceof MarcaponyError ? publicMessage(err) : 'The character could not answer'
          if (!(err instanceof MarcaponyError)) console.error(err)
          controller.enqueue(frame({ type: 'error', code, error }))
          controller.close()
        }
      },
      async cancel() {
        await events.return?.()
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
      },
    })
  }

  async function report(request: Request, slug: string, id: string): Promise<Response> {
    const body = await readBody(request)
    const messageId = body?.messageId
    const reason = body?.reason
    if (
      typeof messageId !== 'string' ||
      typeof reason !== 'string' ||
      !REPORT_REASONS.includes(reason as PersonaReportReason)
    ) {
      return refuse(
        400,
        'validation_failed',
        'Send a messageId and a reason: unsafe, wrong or other',
      )
    }
    const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : undefined
    await mp.personas
      .resume(slug, id)
      .report(messageId, reason as PersonaReportReason, note ? { note } : undefined)
    return json({ reported: true }, 201)
  }

  async function verify(request: Request, slug: string, id: string): Promise<Response> {
    const body = await readBody(request)
    if (!(await passesTurnstile(body?.token, request))) {
      return verificationNeeded('The check did not pass; try again')
    }
    await mp.personas.resume(slug, id).verify()
    return json({ verified: true })
  }

  return async (request) => {
    const matched = route(request)
    if (matched === 'not_found') return refuse(404, 'not_found', 'Not found')
    if (matched === 'method_not_allowed') {
      return refuse(405, 'method_not_allowed', 'Method not allowed')
    }
    try {
      switch (matched.kind) {
        case 'persona': {
          const locale = new URL(request.url).searchParams.get('locale') ?? undefined
          return json(await mp.personas.get(matched.slug, locale ? { locale } : undefined))
        }
        case 'start':
          return await start(request, matched.slug)
        case 'message':
          return await message(request, matched.slug, matched.id)
        case 'report':
          return await report(request, matched.slug, matched.id)
        case 'verify':
          return await verify(request, matched.slug, matched.id)
      }
    } catch (err) {
      if (err instanceof MarcaponyError && err.status >= 400 && err.status < 600) {
        return refuse(err.status, err.code, publicMessage(err))
      }
      console.error(err)
      return refuse(502, 'server_error', 'The character could not answer')
    }
  }
}
