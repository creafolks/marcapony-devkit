import { createClient } from 'marcapony-sdk'

/**
 * The one place that owns the Marcapony env contract and builds the client.
 * Keep it that way: a second `createClient` call somewhere else is how a key
 * ends up read from the wrong place, or bundled into the browser.
 */
export interface MarcaponyBindings {
  /** Scoped app key (`mpk_...`). Written into `.dev.vars` by `marcapony app link`. */
  MARCAPONY_API_KEY?: string
  /** API root. Also written by `app link`; the SDK defaults to production. */
  MARCAPONY_API_URL?: string
}

export type Marcapony = ReturnType<typeof createClient>

/**
 * Workers env is request-scoped, so build the client per request. The SDK is
 * zero-dependency and holds no connections, so construction is effectively free.
 */
export function marcaponyFromEnv(env: MarcaponyBindings): Marcapony {
  if (!env.MARCAPONY_API_KEY) {
    throw new Error(
      'MARCAPONY_API_KEY is missing. Run `bunx marcapony app link` in this project — it writes the key into .dev.vars for you.',
    )
  }
  return createClient({ apiKey: env.MARCAPONY_API_KEY, baseUrl: env.MARCAPONY_API_URL })
}
