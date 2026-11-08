import {
  errorFromResponse,
  isPermanentPersonaError,
  MarcaponyError,
  RateLimitError,
  ServerError,
} from './errors.js'
import type { ResolvedOptions } from './options.js'
import type { ApiPath } from './path.js'
import type { Page, RequestOptions } from './types/index.js'

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface RequestArgs {
  method: HttpMethod
  path: ApiPath
  query?: object
  body?: unknown
  idempotencyKey?: string
  /** Overrides the client's per-attempt timeout. */
  timeoutMs?: number
  /** False sends the request exactly once, whatever the method or key. */
  retry?: boolean
  /** Cancels the request from the caller's side. */
  signal?: AbortSignal
}

/**
 * Ceiling on an honored `Retry-After`. The backoff sleep is deliberately
 * outside the per-attempt abort controller, so `timeoutMs` does not bound it;
 * without a cap a `Retry-After: 3600` from an edge limiter would block the
 * caller for an hour inside what looks like a 30s-timeout request. Anything
 * longer is surfaced as a RateLimitError for the caller to schedule.
 */
export const MAX_RETRY_DELAY_MS = 60_000
const BASE_RETRY_DELAY_MS = 500

/** What one attempt ended with: a value, an error worth retrying, or an error to raise now. */
type AttemptOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'retry'; error: unknown }
  | { kind: 'fail'; error: unknown }

export class Transport {
  constructor(
    private readonly options: ResolvedOptions,
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  /** The same client settings with extra headers on every request. */
  withHeaders(headers: Record<string, string>): Transport {
    return new Transport(this.options, { ...this.extraHeaders, ...headers })
  }

  async request<T>(args: RequestArgs): Promise<T> {
    const url = this.url(args)
    const init = this.init(args)
    const retryable =
      args.retry !== false && (args.method === 'GET' || Boolean(args.idempotencyKey))
    const attempts = retryable ? this.options.maxRetries + 1 : 1

    let lastError: unknown = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(retryDelayMs(attempt, lastError))
      const outcome = await this.attempt(url, init, args)
      if (outcome.kind === 'ok') return outcome.value as T
      if (outcome.kind === 'fail') throw outcome.error
      lastError = outcome.error
    }

    if (lastError instanceof MarcaponyError) throw lastError
    throw new ServerError(
      0,
      'server_error',
      `${args.method} ${args.path} failed after ${attempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
  }

  private url(args: RequestArgs): string {
    const url = new URL(this.options.baseUrl + args.path)
    for (const [key, value] of Object.entries(args.query ?? {}) as Array<[string, unknown]>) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  private init(args: RequestArgs, accept = 'application/json'): RequestInit {
    const headers: Record<string, string> = {
      ...this.extraHeaders,
      Authorization: `Bearer ${this.options.apiKey}`,
      Accept: accept,
    }
    if (args.body !== undefined) headers['Content-Type'] = 'application/json'
    if (args.idempotencyKey) headers['Idempotency-Key'] = args.idempotencyKey
    return {
      method: args.method,
      headers,
      body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
    }
  }

  /** One fetch under the per-attempt timeout. Network failures and aborts are retryable. */
  private async attempt(
    url: string,
    init: RequestInit,
    args: RequestArgs,
  ): Promise<AttemptOutcome> {
    const abort = linkedAbort(args.timeoutMs ?? this.options.timeoutMs, args.signal)
    try {
      const response = await this.options.fetch(url, { ...init, signal: abort.signal })
      const body = await readJson(response)
      return classifyResponse(response, body, args)
    } catch (err) {
      if (err instanceof MarcaponyError) return { kind: 'fail', error: err }
      // The caller gave up: hand back its own reason and do not try again.
      if (args.signal?.aborted) return { kind: 'fail', error: abortedError(args, args.signal) }
      return { kind: 'retry', error: err }
    } finally {
      abort.done()
    }
  }

  /**
   * A request answered with server-sent events. Sent exactly once, never
   * retried: the server may have started (and counted) the work before the
   * connection failed. `timeoutMs` bounds the whole stream, not only the first
   * byte. A non-2xx answer throws its `MarcaponyError` before anything is
   * yielded; each `data:` frame is yielded as parsed JSON.
   */
  async *stream(args: RequestArgs): AsyncGenerator<unknown, void, undefined> {
    const url = this.url(args)
    const abort = linkedAbort(args.timeoutMs ?? this.options.timeoutMs, args.signal)
    try {
      let response: Response
      try {
        response = await this.options.fetch(url, {
          ...this.init(args, 'text/event-stream'),
          signal: abort.signal,
        })
      } catch (err) {
        throw streamFailure(args, err, abort.signal)
      }
      if (!response.ok) {
        throw errorFromResponse(
          response.status,
          (await readJson(response)).value as Parameters<typeof errorFromResponse>[1],
          response.headers.get('Retry-After'),
          { method: args.method, path: args.path },
        )
      }
      if (!response.body) {
        throw new ServerError(
          response.status,
          'server_error',
          `${args.method} ${args.path}: empty stream`,
        )
      }
      const parser = new SseParser()
      const reader = response.body.getReader()
      try {
        for (;;) {
          const chunk = await reader.read().catch((err: unknown) => {
            throw streamFailure(args, err, abort.signal)
          })
          if (chunk.done) break
          for (const frame of parser.push(chunk.value)) yield frame
        }
        for (const frame of parser.flush()) yield frame
      } finally {
        // Ends the connection when the caller stops iterating early.
        reader.cancel().catch(() => undefined)
      }
    } finally {
      abort.done()
    }
  }
}

/** An abort controller that fires on the timeout or on the caller's signal, whichever comes first. */
function linkedAbort(timeoutMs: number, outer?: AbortSignal) {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException('The request timed out', 'TimeoutError')),
    timeoutMs,
  )
  const onAbort = () => controller.abort(outer?.reason)
  if (outer?.aborted) onAbort()
  else outer?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    },
  }
}

function abortedError(args: RequestArgs, signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException(`${args.method} ${args.path} was aborted`, 'AbortError')
}

/** What a failed stream throws: the caller's own abort reason, or a ServerError for a timeout or a dropped connection. */
function streamFailure(args: RequestArgs, err: unknown, signal: AbortSignal): unknown {
  if (args.signal?.aborted) return abortedError(args, args.signal)
  const reason = signal.aborted ? 'timed out' : err instanceof Error ? err.message : String(err)
  return new ServerError(0, 'server_error', `${args.method} ${args.path} stream failed: ${reason}`)
}

/**
 * Splits a server-sent event stream into the JSON of its `data:` fields. Only
 * `data` matters on this surface; comments and other fields are skipped, and
 * so is a frame whose data is not JSON.
 */
export class SseParser {
  private readonly decoder = new TextDecoder()
  private buffer = ''

  push(bytes: Uint8Array): unknown[] {
    this.buffer += this.decoder.decode(bytes, { stream: true })
    return this.drain(false)
  }

  flush(): unknown[] {
    this.buffer += this.decoder.decode()
    return this.drain(true)
  }

  private drain(final: boolean): unknown[] {
    const frames: unknown[] = []
    const blocks = this.buffer.replace(/\r\n/g, '\n').split('\n\n')
    this.buffer = final ? '' : (blocks.pop() ?? '')
    for (const block of blocks) {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
      if (data.length === 0) continue
      try {
        frames.push(JSON.parse(data.join('\n')))
      } catch {
        // Not JSON: not a frame of this surface.
      }
    }
    return frames
  }
}

/** The parsed body; `parsed: false` when there was a body that is not JSON (or it could not be read). */
async function readJson(response: Response): Promise<{ parsed: boolean; value: unknown }> {
  try {
    const text = await response.text()
    return { parsed: true, value: text.length > 0 ? JSON.parse(text) : null }
  } catch {
    return { parsed: false, value: null }
  }
}

function classifyResponse(
  response: Response,
  body: { parsed: boolean; value: unknown },
  args: RequestArgs,
): AttemptOutcome {
  if (response.ok) {
    // A 2xx whose body did not parse is a truncated or proxy-mangled response,
    // not an empty one. Returning null would surface later as an opaque
    // TypeError in the caller's code; treat it as a retryable server failure.
    if (!body.parsed) {
      return {
        kind: 'retry',
        error: new ServerError(
          response.status,
          'server_error',
          `${args.method} ${args.path} → ${response.status}: response body was not valid JSON`,
        ),
      }
    }
    return { kind: 'ok', value: body.value }
  }

  const error = errorFromResponse(
    response.status,
    body.value as Parameters<typeof errorFromResponse>[1],
    response.headers.get('Retry-After'),
    { method: args.method, path: args.path },
  )
  if (response.status !== 429 && response.status < 500) return { kind: 'fail', error }
  if (isPermanentPersonaError(error)) return { kind: 'fail', error }
  // Honoring a Retry-After beyond the cap would stall the caller far past its
  // own timeout; hand the decision back instead.
  if (
    error instanceof RateLimitError &&
    error.retryAfter !== null &&
    error.retryAfter * 1000 > MAX_RETRY_DELAY_MS
  ) {
    return { kind: 'fail', error }
  }
  return { kind: 'retry', error }
}

/**
 * The wait before retry number `attempt` (1-based). A server `Retry-After` is
 * honored as given (it is at most the cap here, see `classifyResponse`).
 * Otherwise exponential backoff with full jitter: a random wait between 0 and
 * 500 ms × 2^(attempt-1), so many clients failing together do not retry in step.
 */
export function retryDelayMs(
  attempt: number,
  lastError: unknown,
  random: () => number = Math.random,
): number {
  if (lastError instanceof RateLimitError && lastError.retryAfter) {
    return Math.min(lastError.retryAfter * 1000, MAX_RETRY_DELAY_MS)
  }
  return Math.floor(random() * BASE_RETRY_DELAY_MS * 2 ** (attempt - 1))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The `data` of a `{ data }` envelope. */
export function unwrap<T>(envelope: { data: T } | null): T {
  // Every /ext/v1 success carries `{ data }`; a bodiless 2xx can only come from
  // something in front of the surface, and must not surface as a bare TypeError.
  if (envelope === null || typeof envelope !== 'object' || !('data' in envelope)) {
    throw new ServerError(200, 'server_error', 'Response did not carry a { data } envelope')
  }
  return envelope.data
}

/** GET a single record or a plain array, unwrapped from its envelope. */
export function get<T>(t: Transport, path: ApiPath, query?: object): Promise<T> {
  return t.request<{ data: T }>({ method: 'GET', path, query }).then(unwrap)
}

/** GET one page of a paginated list; `{ data, meta }` is returned as is. */
export function list<T>(t: Transport, path: ApiPath, query?: object): Promise<Page<T>> {
  return t.request<Page<T>>({ method: 'GET', path, query })
}

/** POST, retried only when an idempotency key makes it safe. */
export function create<T>(
  t: Transport,
  path: ApiPath,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  return t
    .request<{ data: T }>({ method: 'POST', path, body, idempotencyKey: options?.idempotencyKey })
    .then(unwrap)
}

/** PATCH a record. */
export function update<T>(t: Transport, path: ApiPath, body: unknown): Promise<T> {
  return t.request<{ data: T }>({ method: 'PATCH', path, body }).then(unwrap)
}

/** DELETE a record. The envelope is still checked; what it carries is not part of the contract. */
export function remove(t: Transport, path: ApiPath, query?: object): Promise<void> {
  return t
    .request<{ data: unknown }>({ method: 'DELETE', path, query })
    .then(unwrap)
    .then(() => undefined)
}
