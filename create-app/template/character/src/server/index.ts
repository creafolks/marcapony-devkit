import { Hono } from 'hono'
import { personasHandler } from 'marcapony-sdk'
import { errorResponse, marcaponyFromEnv, type MarcaponyBindings } from './marcapony'

/**
 * A character from the business that chats with visitors. The browser talks
 * to this app's own `/api/chat/*` routes and never sees the app key;
 * `personasHandler` forwards each message to the character and streams the
 * answer back.
 */
interface Bindings extends MarcaponyBindings {
  /**
   * Signs the visitor cookie. Marcapony sets it once a character is granted
   * to this app, and it stays the same across deploys.
   */
  MARCAPONY_APP_SECRET?: string
  /** The slug of the character to talk to, as an environment setting. */
  PERSONA_SLUG?: string
  /** Optional: your own Turnstile widget, to check visitors before they chat. */
  TURNSTILE_SITE_KEY?: string
  TURNSTILE_SECRET_KEY?: string
}

const app = new Hono<{ Bindings: Bindings }>()

/** Locally there is no app secret; a fixed value keeps the cookie working in `bun run dev`. */
const LOCAL_SECRET = 'local-development-only-not-a-real-app-secret'

function appSecret(env: Bindings): string {
  if (env.MARCAPONY_APP_SECRET) return env.MARCAPONY_APP_SECRET
  // The platform sets MARCAPONY_APP_ID on every deploy, so its absence means local dev.
  if (!env.MARCAPONY_APP_ID) return LOCAL_SECRET
  throw new Error(
    'MARCAPONY_APP_SECRET is missing. Grant a character to this app in the dashboard, then deploy again.',
  )
}

function personaSlug(env: Bindings): string {
  if (!env.PERSONA_SLUG) {
    throw new Error(
      'PERSONA_SLUG is not set. Set it to the slug of the character this app talks to.',
    )
  }
  return env.PERSONA_SLUG
}

app.get('/api/health', (c) => c.json({ ok: true }))

/** The character the interface shows: name, greeting and starter questions. */
app.get('/api/character', async (c) => {
  const mp = marcaponyFromEnv(c.env)
  return c.json(await mp.personas.get(personaSlug(c.env)))
})

app.all('/api/chat/*', (c) => {
  const turnstile =
    c.env.TURNSTILE_SITE_KEY && c.env.TURNSTILE_SECRET_KEY
      ? { siteKey: c.env.TURNSTILE_SITE_KEY, secretKey: c.env.TURNSTILE_SECRET_KEY }
      : undefined
  const chat = personasHandler(marcaponyFromEnv(c.env), {
    secret: appSecret(c.env),
    basePath: '/api/chat',
    // Only this app's own character can be addressed from the browser.
    personas: [personaSlug(c.env)],
    turnstile,
  })
  return chat(c.req.raw)
})

app.onError((err) => errorResponse(err))

export default app
