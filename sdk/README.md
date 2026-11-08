# marcapony-sdk

Official TypeScript client for the Marcapony external API (`/ext/v1`). Zero
runtime dependencies; runs anywhere `fetch` does (Cloudflare Workers, Node ≥20,
Bun, Deno).

## Install

```sh
npm install marcapony-sdk@~0.8.0
```

The SDK is 0.x, so a minor release may contain breaking changes. Pin a minor
range (`~0.8.0`) and read [CHANGELOG.md](./CHANGELOG.md) before upgrading.

## Quickstart

```ts
import { createClient } from 'marcapony-sdk'

const mp = createClient({ apiKey: process.env.MARCAPONY_API_KEY! })

const link = await mp.paymentLinks.create(
  {
    title: 'Order #1042',
    amount: 250,
    currency: 'TRY',
    successUrl: 'https://example.com/thanks',
  },
  { idempotencyKey: 'order-1042' },
)
console.log(link.paymentUrl)
```

Amounts and prices are numbers in the currency's major unit (`250` is 250.00
TRY), never minor units. Order costs are always computed on the server from the
catalog; payment links are the one call that takes a free amount, which is why
the key must stay on your backend.

## Keys and scopes

Register your app under **My Apps** in the Marcapony dashboard with only the
scopes it needs, then run `npx marcapony app link`. It writes an app key
(`mpk_...`) into `.dev.vars` and adds that file to `.gitignore`; never commit
it. If a key leaks, revoke it in the dashboard and run `npx marcapony app link` again.

The client refuses to run with a secret key in a browser. Call the API from
your backend (`dangerouslyAllowBrowser: true` exists, but a key in a bundle is
public).

## Lists and pagination

Paginated lists return `{ data, meta: { page, perPage, total } }`:

```ts
for (let page = 1; ; page++) {
  const { data, meta } = await mp.products.list({ page, perPage: 50 })
  handle(data)
  if (page * meta.perPage >= meta.total) break
}
```

## Test mode

A new app starts in test mode: reads return real data, writes are not saved.
A create or update then resolves to its input echoed back with an id and
`simulated: true`, without server-computed fields such as `paymentUrl`:

```ts
const link = await mp.paymentLinks.create(input, { idempotencyKey })
if (link.simulated) return showNothingToPay()
sendToCustomer(link.paymentUrl)
```

The owner turns test mode off in the dashboard.

## Errors, retries and rate limits

Every non-2xx response throws a subclass of `MarcaponyError` with `status`,
`code` and `fields`: `ValidationError`, `InsufficientScopeError`,
`PermissionDeniedError`, `NotFoundError`, `ConflictError`, `RateLimitError`,
`TierLimitError`, `PluginRequiredError`, `UnauthorizedError`, `ServerError`.
`tier_limit_exceeded` and `plugin_required` are permanent for the current plan;
do not retry them.

GETs retry on 429, 5xx and network errors (2 retries by default, backoff with
jitter, `Retry-After` honored up to 60 s). POSTs retry only with
`{ idempotencyKey }`; the server replays the first response for the same key
for 48 hours. Use a stable key derived from what you are charging for, and
reconcile money movement on your side.

Requests are rate limited per key (and per signed-in person for `forRequest()`
calls). A 429 raises `RateLimitError`, with `retryAfter` in seconds, once the
SDK's own retries are used up.

Record ids are percent-encoded into the path, and an empty, `.` or `..` id
throws before any request is sent.

## Options

| Option       | Default                            |                                          |
| ------------ | ---------------------------------- | ---------------------------------------- |
| `baseUrl`    | `https://api.marcapony.com/ext/v1` | Override the API root                    |
| `timeoutMs`  | `30000`                            | Per-request timeout                      |
| `maxRetries` | `2`                                | Idempotent requests only                 |
| `fetch`      | `globalThis.fetch`                 | Override for tests or instrumentation    |
| `appId`      | none                               | `env.MARCAPONY_APP_ID`; for `identity()` |

## Signed-in visitors and team members

An app in the customer portal receives a signed identity on every request from
a signed-in person. Read it with `identity()` and make calls on their behalf
through `forRequest()`, created per request and never cached in module scope.

```ts
const mp = createClient({
  apiKey: env.MARCAPONY_API_KEY,
  appId: env.MARCAPONY_APP_ID,
})
const who = await mp.identity(request) // null when nobody is signed in
if (!who) return new Response('Please sign in', { status: 401 })
const bookings = await mp.forRequest(request).me.reservations.list()
```

When a team member opens the app from the dashboard, `who.kind` is `'member'`
and the account groups apply instead of `me`:

```ts
await mp.forRequest(request).reservations.updateStatus(id, { status: 'approved' })
```

| Client                       | Calls                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `forRequest(request).me`     | `profile.get`, `reservations.list/get/create/cancel`, `orders.list/get`, `paymentLinks.list/get`, `formSubmissions.list` (metadata only) |
| `forRequest(request)` member | `reservations.list/get/create/updateStatus`, `orders.list/get`, `customers.list/get`                                                     |

- `identity()` is for display; the platform enforces access on every call.
  `who.can(id)` checks a permission from your `marcapony.json`, and
  `who.preview` is true while the owner previews the app (writes are simulated).
- A customer-facing app without an identity gets 403 `identity_required`
  (`PermissionDeniedError`) on customer data, even with the scope.
- Never read, log or forward the identity header or the portal cookie.
- Locally there is no identity: `identity()` throws without `appId` and returns
  null with it, and `forRequest()` throws `UnauthorizedError`. Test portal and
  team flows on the deployed app from the dashboard.

## Data access

Every app declares whose data it works with (`dataAccess` in `marcapony.json`,
set in the dashboard):

| `dataAccess` | Placement | Plain client (no identity)                                      |
| ------------ | --------- | --------------------------------------------------------------- |
| `account`    | site      | every route its scopes allow (integrations, back-office tools)  |
| `visitor`    | site      | catalog reads, bookings and form entries for anonymous visitors |
| `customer`   | portal    | the same as `visitor`; `me.*` through `forRequest()`            |
| `team`       | portal    | the same as `visitor`; account groups through `forRequest()`    |

A deploy can only narrow it; widening is done in the dashboard.

## Characters

An app or a game can talk to the account's characters from its server. The
owner creates a character in the dashboard, switches it on for apps, gives it a
daily budget and grants it to the app; granting adds the `personas:chat` scope
to the app's environments. Only granted characters exist for the app: any other
slug answers `NotFoundError`.

```ts
const mp = createClient({ apiKey: env.MARCAPONY_API_KEY, baseUrl: env.MARCAPONY_API_URL })

const chat = await mp.personas.start('barista', { endUser: player.id, locale: 'en' })
for await (const event of chat.stream('What do you recommend today?')) {
  if (event.type === 'text') show(event.content)
}
const reply = await chat.send('And a dessert?') // waits for the whole answer
```

| Call                                     | What it does                                                    |
| ---------------------------------------- | --------------------------------------------------------------- |
| `personas.list()`, `personas.get(slug)`  | The granted characters: name, description, avatar, greeting, starter questions, `available` |
| `personas.start(slug, options)`          | Starts a conversation and returns a chat                        |
| `personas.resume(slug, id, { history, endUser })` | A chat for a conversation you stored; makes no request          |
| `chat.send(text)`                        | Sends a message and resolves to `{ messageId, text, turn, testMode }` |
| `chat.stream(text)`                      | The same message, as events while the answer is written         |
| `chat.report(messageId, reason)`         | Reports an answer as `'unsafe'`, `'wrong'` or `'other'`         |
| `chat.verify()`                          | Records that you checked the visitor (see Turnstile below)      |
| `chat.transcript()`                      | The stored messages, when the character keeps transcripts       |

- `personas` is only on the client from `createClient`, never on
  `forRequest()`: these calls do not act as a signed-in person. To use a
  signed-in person's id as the end user, pass it as `endUser`.
- `endUser` is your own opaque id for the player or visitor (not an e-mail
  address). Marcapony stores only a keyed hash of it and uses it for the
  per-player limits. Pass `endUserIp` too, so the limit on new players per
  address applies.
- A conversation started with `endUser` belongs to that player: every later
  call must name the same id, or it answers `NotFoundError`. The chat sends it
  for you (`chat.endUser`); pass it to `resume` as `{ endUser }` as well.
- A stream yields `message_start` (the id of the answer), `text`, `tool_call`
  and `tool_result` (the character looked something up), `retract` and `done`.
  `retract` withdraws the message with that id: remove what you showed of it.
  A new `message_start` follows with the replacement.
- A turn that fails ends with an `error` event and no `done`: the iterator
  throws, and nothing of the turn is kept in the history. Remove the text you
  showed of it. `send` never resolves to a partial answer; it throws
  `PersonaUnavailableError`, `ServerError` (`service_unavailable` or
  `server_error`) instead.
- A message is never retried, so a dropped connection can never be charged
  twice; send it again yourself if you want to. The one exception is a refused
  history (see History), which the API refuses before the turn runs. A message may take up to 120
  seconds, whatever `timeoutMs` is set to. Send one message of a chat at a time.

### History

Unless the character keeps transcripts (`chat.storesTranscripts`), Marcapony
remembers nothing between messages: each message carries the conversation so
far. The API signs every answer and every accepted visitor message, and refuses
a history with a missing or changed signature (`ValidationError`,
`invalid_history`), so nobody can put words in the character's mouth. The chat
keeps the signed entries in `chat.history` and sends them for you: at most 30,
the oldest dropped first. A visitor message may be up to 2,000 characters
(`PERSONA_HISTORY_MAX_USER_CHARS`); an answer comes back as long as the
character wrote it, up to 32,768 characters
(`PERSONA_HISTORY_MAX_ANSWER_CHARS`), and is accepted back in full. Once a conversation has answered, every message
must carry at least one signed answer. When the history is refused anyway, a
chat from `start` begins a new conversation with the same options and sends the
message there (`chat.id` changes, so store it again); a chat from `resume`
throws `ValidationError` with `invalid_history`, and you start a new one.
Store the entries with the conversation id if you need to `resume` later.

### Errors

| Error                        | Codes                                                         |
| ---------------------------- | ------------------------------------------------------------- |
| `PersonaUnavailableError`    | `persona_unavailable`, `feature_paused`: switched off or paused for now |
| `PersonaLimitError`          | a budget or limit was reached: `persona_daily_cap`, `persona_monthly_cap`, `app_daily_cap`, `account_daily_credit_cap`, `daily_limit_reached`, `monthly_limit_reached`, `conversation_limit_reached`, `test_mode_daily_cap`, `beta_budget_reached` |
| `VerificationRequiredError`  | `verification_required`                                       |
| `RateLimitError`             | `rate_limited`: too many messages from one player, or too many new players from one address |

A game can show "the shopkeeper is resting" for the first two instead of
failing. No request is ever retried on them. An `error` event in a stream is
thrown by the iterator as the same classes.

A `RateLimitError` carries `retryAfter`, the seconds to wait. A start with an
`idempotencyKey` waits that long and tries again by itself when it is 60
seconds or less; a message is never sent again, so wait and send it yourself.
`personasHandler` passes the wait on to the browser as a `Retry-After` header.

### Test mode

While the app is in test mode, characters answer on a cheaper model, nothing is
charged, and each app has 50 test messages a day (`test_mode_daily_cap`).
Answers carry `testMode: true`.

### `personasHandler`

The browser must never hold the app key, so the chat screen calls the app's
own route, and `personasHandler` forwards it:

```ts
import { Hono } from 'hono'
import { createClient, personasHandler } from 'marcapony-sdk'

const app = new Hono<{ Bindings: Env }>()
app.all('/api/chat/*', (c) => {
  const mp = createClient({ apiKey: c.env.MARCAPONY_API_KEY, baseUrl: c.env.MARCAPONY_API_URL })
  return personasHandler(mp, { secret: c.env.MARCAPONY_APP_SECRET })(c.req.raw)
})
```

| Route below `basePath` (default `/api/chat`)  | Body                                   |
| ---------------------------------------------- | -------------------------------------- |
| `GET /:slug`                                   | The character's summary                |
| `POST /:slug/conversations`                    | `{ locale? }` → `{ conversationId, storesTranscripts, testMode }` |
| `POST /:slug/conversations/:id/messages`       | `{ text, history?, turnstileToken? }` → the reply and `history`; streams when the request accepts `text/event-stream`, with `history` on the `done` event |
| `POST /:slug/conversations/:id/reports`        | `{ messageId, reason, note? }`         |
| `POST /:slug/conversations/:id/verify`         | `{ token }`, with Turnstile only       |

Errors come back as `{ code, error }` with the API's status.

- **The visitor cookie.** The handler gives every visitor an anonymous id in
  the `mp_eu` cookie (HttpOnly, Secure, SameSite=Lax, Path `/`, one year),
  signed with `MARCAPONY_APP_SECRET`, and sends it as `endUser`. A missing or
  forged cookie gets a new id. Marcapony sets `MARCAPONY_APP_SECRET` for every
  environment of an app that a character is granted to; it stays the same
  across deploys, and rotating it in the dashboard gives every visitor a new
  id. Locally there is none: pass a fixed development value of at least 32
  characters. An app with its own sign-in can pass
  `endUser: (request) => id` instead (return null to fall back to the cookie).
- **Visitor IP.** The handler passes the visitor's address as `endUserIp`
  (and to the Turnstile check), read from `cf-connecting-ip` by default. Only
  Cloudflare sets that header in a way a browser cannot forge: on any other
  host, or behind another proxy, pass `clientIp: (request) => ...` reading a
  source you trust, or the limit on new visitors per address can be bypassed.
- **History.** The handler stores nothing. It forwards the history the browser
  sends, unchanged, and returns the signed list to keep for the next message
  (for example in `sessionStorage`).
- **Allow-list.** `personas: ['barista']` limits which slugs the browser may
  address; by default every granted character.
- **Turnstile.** For a public game, pass `turnstile: { siteKey, secretKey }`
  from your own Turnstile widget. Conversations then need a check before the
  first message and after every 10 messages: the handler answers 401
  `{ code: 'verification_required', turnstileSiteKey }`, the browser shows the
  widget and sends the message again with `turnstileToken`, and the handler
  checks the token with Cloudflare, calls `chat.verify()` and sends the
  message once more.

### Your players' data

You are the data controller for your players: the end-user ids you pass or the
handler's cookie creates, and everything players type. Say so in your privacy
notice, and do not put personal data in `endUser` or `metadata`.

## License

Proprietary: free to install, bundle into your own applications, and ship those
applications anywhere; not to republish as a standalone package. See
[LICENSE.md](./LICENSE.md).
