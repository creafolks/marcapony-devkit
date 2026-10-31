import { createClient } from 'marcapony-sdk'

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
