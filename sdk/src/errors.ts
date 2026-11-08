export interface ApiFieldError {
  field: string
  message: string
}

/**
 * Base error for every non-2xx /ext/v1 response. `code` is the closed set the
 * surface promises; subclasses exist so `instanceof` switching works without
 * string-matching.
 */
export class MarcaponyError extends Error {
  readonly status: number
  readonly code: string
  readonly fields: ApiFieldError[]

  constructor(status: number, code: string, message: string, fields: ApiFieldError[] = []) {
    super(message)
    this.name = new.target.name
    this.status = status
    this.code = code
    this.fields = fields
  }
}

export class UnauthorizedError extends MarcaponyError {}
export class InsufficientScopeError extends MarcaponyError {}
export class PermissionDeniedError extends MarcaponyError {}
export class NotFoundError extends MarcaponyError {}
export class ValidationError extends MarcaponyError {}
export class PluginRequiredError extends MarcaponyError {}
export class TierLimitError extends MarcaponyError {}
export class RateLimitError extends MarcaponyError {
  /** Seconds to wait, from the Retry-After header when present. */
  readonly retryAfter: number | null

  constructor(
    status: number,
    code: string,
    message: string,
    fields: ApiFieldError[],
    retryAfter: number | null,
  ) {
    super(status, code, message, fields)
    this.retryAfter = retryAfter
  }
}
export class ConflictError extends MarcaponyError {}
export class ServerError extends MarcaponyError {}

/**
 * The character cannot answer this app right now: it is switched off, paused,
 * not enabled for apps, or characters are paused platform-wide
 * (`persona_unavailable`, `feature_paused`). Show something like "the
 * shopkeeper is resting" instead of an error.
 */
export class PersonaUnavailableError extends MarcaponyError {}

/**
 * A spending or usage cap of characters was reached (see
 * `PERSONA_LIMIT_CODES`; `code` says which). A cap does not clear in seconds,
 * so no request is ever retried on one.
 */
export class PersonaLimitError extends MarcaponyError {}

/**
 * The conversation was started with `requireVerification` and needs a fresh
 * bot check: verify the visitor (for example with Turnstile), call
 * `chat.verify()`, then send the message again.
 */
export class VerificationRequiredError extends MarcaponyError {}

/** The codes `PersonaLimitError` carries. */
export const PERSONA_LIMIT_CODES = [
  'account_daily_credit_cap',
  'daily_limit_reached',
  'monthly_limit_reached',
  'persona_daily_cap',
  'persona_monthly_cap',
  'app_daily_cap',
  'conversation_limit_reached',
  'test_mode_daily_cap',
  'beta_budget_reached',
] as const

export type PersonaLimitCode = (typeof PERSONA_LIMIT_CODES)[number]

const ERROR_BY_CODE: Record<
  string,
  new (
    status: number,
    code: string,
    message: string,
    fields: ApiFieldError[],
  ) => MarcaponyError
> = {
  unauthorized: UnauthorizedError,
  insufficient_scope: InsufficientScopeError,
  permission_denied: PermissionDeniedError,
  not_found: NotFoundError,
  validation_failed: ValidationError,
  plugin_required: PluginRequiredError,
  tier_limit_exceeded: TierLimitError,
  conflict: ConflictError,
  invalid_identity: UnauthorizedError,
  scoped_route_required: PermissionDeniedError,
  identity_required: PermissionDeniedError,
  server_error: ServerError,
  service_unavailable: ServerError,
  invalid_history: ValidationError,
  persona_unavailable: PersonaUnavailableError,
  feature_paused: PersonaUnavailableError,
  verification_required: VerificationRequiredError,
  ...Object.fromEntries(PERSONA_LIMIT_CODES.map((code) => [code, PersonaLimitError])),
}

/**
 * Not every non-2xx body comes from /ext/v1 — a proxy, gateway or CDN in front
 * of it answers with HTML and no envelope. Defaulting those to `server_error`
 * would misclassify an edge 429 (losing Retry-After) and an edge 404, so fall
 * back to the status the same way the surface maps its own codes.
 */
const CODE_BY_STATUS: Record<number, string> = {
  400: 'validation_failed',
  401: 'unauthorized',
  403: 'permission_denied',
  404: 'not_found',
  409: 'conflict',
  422: 'validation_failed',
  429: 'rate_limited',
}

/**
 * The message alone must be enough to debug from a log line — integrators
 * routinely log only `error.message`, so it carries the request line, status,
 * code, and any field-level detail alongside the server's message.
 */
export function errorFromResponse(
  status: number,
  body: { error?: { code?: string; message?: string; fields?: ApiFieldError[] } } | null,
  retryAfterHeader: string | null,
  request?: { method: string; path: string },
): MarcaponyError {
  const code = body?.error?.code ?? CODE_BY_STATUS[status] ?? 'server_error'
  const fields = body?.error?.fields ?? []
  const serverMessage = body?.error?.message ?? `Request failed with status ${status}`
  const fieldsSuffix = fields.length
    ? ` [${fields.map((f) => `${f.field}: ${f.message}`).join('; ')}]`
    : ''
  const prefix = request ? `${request.method} ${request.path} → ${status} ${code}: ` : ''
  const message = `${prefix}${serverMessage}${fieldsSuffix}`

  if (code === 'rate_limited') {
    // A negative or non-numeric Retry-After (HTTP-date form, a broken proxy)
    // must not become a negative sleep — fall back to exponential backoff.
    const parsed = retryAfterHeader === null ? NaN : Number(retryAfterHeader)
    const retryAfter = Number.isFinite(parsed) && parsed >= 0 ? parsed : null
    return new RateLimitError(status, code, message, fields, retryAfter)
  }

  const ErrorClass = ERROR_BY_CODE[code] ?? MarcaponyError
  return new ErrorClass(status, code, message, fields)
}

/**
 * Whether an error must never be retried whatever its status: a character
 * cap or a pause does not clear in seconds, and retrying it only adds load.
 */
export function isPermanentPersonaError(error: unknown): boolean {
  return error instanceof PersonaLimitError || error instanceof PersonaUnavailableError
}
