import { createClient, MarcaponyError, type Identity } from 'marcapony-sdk'

/**
 * The one place that owns the Marcapony env contract and builds the client.
 * Keep it that way: a second `createClient` call somewhere else is how a key
 * ends up read from the wrong place, or bundled into the browser.
 */
export interface MarcaponyBindings {
  /** Scoped app key (`mpk_...`). Written into `.dev.vars` by `bun run link`. */
  MARCAPONY_API_KEY?: string
  /** API root. Also written by `bun run link`; the SDK defaults to production. */
  MARCAPONY_API_URL?: string
  /**
   * The app's id. The platform sets it when the app is deployed, and
   * `identity()` needs it to check who is signed in. `bun run link` does not
   * write it, so locally there is no app id (and no identity header either):
   * identity is always null in local dev.
   */
  MARCAPONY_APP_ID?: string
}

export type Marcapony = ReturnType<typeof createClient>

/**
 * Workers env is request-scoped, so build the client per request. The SDK is
 * zero-dependency and holds no connections, so construction is effectively free.
 */
export function marcaponyFromEnv(env: MarcaponyBindings): Marcapony {
  if (!env.MARCAPONY_API_KEY) {
    throw new Error(
      'MARCAPONY_API_KEY is missing. Run `bun run link` in this project. It writes the key into .dev.vars for you.',
    )
  }
  return createClient({
    apiKey: env.MARCAPONY_API_KEY,
    baseUrl: env.MARCAPONY_API_URL,
    appId: env.MARCAPONY_APP_ID,
  })
}

/**
 * Who is signed in on this request, or null. The SDK's `identity()` throws
 * without an app id; locally there is none, so this answers null there instead
 * of failing every request. Use it for display and for hiding buttons only:
 * the platform enforces access itself on every call.
 */
export async function identityOf(
  mp: Marcapony,
  env: MarcaponyBindings,
  request: Request,
): Promise<Identity | null> {
  if (!env.MARCAPONY_APP_ID) return null
  return mp.identity(request)
}

/**
 * Whether Marcapony only simulated a write. New apps start in test mode, where
 * writes answer with the record they would have created, marked
 * `simulated: true`, and nothing is saved. The SDK types do not declare the
 * marker yet, so read it defensively.
 */
export function isSimulated(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { simulated?: unknown }).simulated === true
  )
}

/**
 * Turns a failed call into a JSON answer for the browser. A Marcapony error
 * keeps its status (401 not signed in, 403 not allowed, 404, 422 invalid
 * input, 429) so the interface can tell the visitor what happened; anything
 * else is a 500.
 */
export function errorResponse(err: unknown): Response {
  if (err instanceof MarcaponyError && err.status >= 400 && err.status < 500) {
    return Response.json({ error: err.message, code: err.code }, { status: err.status })
  }
  console.error(err)
  return Response.json(
    { error: err instanceof Error ? err.message : 'Unexpected error' },
    { status: 500 },
  )
}
