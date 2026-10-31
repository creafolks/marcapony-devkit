import { errorFromResponse, MarcaponyError, RateLimitError, ServerError } from './errors.js'
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
  | { kind: 'fail'; error: MarcaponyError }

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
    const retryable = args.method === 'GET' || Boolean(args.idempotencyKey)
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

  private init(args: RequestArgs): RequestInit {
    const headers: Record<string, string> = {
      ...this.extraHeaders,
      Authorization: `Bearer ${this.options.apiKey}`,
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
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs)
    try {
      const response = await this.options.fetch(url, { ...init, signal: controller.signal })
      const body = await readJson(response)
      return classifyResponse(response, body, args)
    } catch (err) {
      if (err instanceof MarcaponyError) return { kind: 'fail', error: err }
      return { kind: 'retry', error: err }
    } finally {
      clearTimeout(timer)
    }
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
