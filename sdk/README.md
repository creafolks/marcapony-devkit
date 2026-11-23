# marcapony-sdk

Official TypeScript client for the Marcapony external API (`/ext/v1`). Zero
runtime dependencies; runs anywhere `fetch` does (Cloudflare Workers, Node ≥20,
Bun, Deno).

## Install

```sh
npm install marcapony-sdk@~0.9.0
```

The SDK is 0.x, so a minor release may contain breaking changes. Pin a minor
range (`~0.9.0`) and read [CHANGELOG.md](./CHANGELOG.md) before upgrading.

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
| `forRequest(request).me`     | `profile.get`, `reservations.list/get/create/cancel`, `orders.list/get`, `paymentLinks.list/get`, `formSubmissions.list` (metadata only), `records(name)`, and for a marketplace seller `products.list/get/create/update/variants/setVariants/submit/unpublish/delete` and `media.upload` |
| `forRequest(request)` member | `reservations.list/get/create/updateStatus`, `orders.list/get`, `customers.list/get`, `products.*`, `categories.list`, `variantTypes.list` |

- `identity()` is for display; the platform enforces access on every call.
  `who.can(id)` checks a permission from your `marcapony.json`, and
  `who.preview` is true while the owner previews the app (writes are simulated).
- A customer-facing app without an identity gets 403 `identity_required`
  (`PermissionDeniedError`) on customer data, even with the scope.
- Never read, log or forward the identity header or the portal cookie.
- Locally there is no identity: `identity()` throws without `appId` and returns
  null with it, and `forRequest()` throws `UnauthorizedError`. Test portal and
  team flows on the deployed app from the dashboard.

## Your app's own records

A customer app in the portal can keep JSON records for the signed-in customer:
preferences, a log, a wish list. Declare a collection under `collections` in
`marcapony.json` together with a permission that grants `records.own.read`
and `records.own.write` (see the `marcapony` CLI's README), deploy, and have
the owner give that permission to customers on the app's page. Then:

```ts
interface Entry extends Record<string, unknown> {
  status: 'open' | 'done'
  loggedAt: string
}

const entries = mp.forRequest(request).me.records<Entry>('entries')

await entries.put('2026-11-14', { status: 'done', loggedAt: '2026-11-14' })
const one = await entries.get('2026-11-14') // null when there is none
const page = await entries.list({ index: 'loggedAt', gte: '2026-11-01', order: 'desc' })
if (one) await entries.put(one.key, { ...one.data, status: 'open' }, { ifVersion: one.version })
await entries.delete('2026-11-14')
const created = await entries.create({ status: 'open', loggedAt: '2026-11-15' })
```

- Reads need the `records.own.read` grant and writes `records.own.write`. A
  customer without the permission gets `PermissionDeniedError` (403).
- A record belongs to the customer who wrote it. The platform takes the
  customer from the identity, so two customers can use the same key and
  neither can reach the other's record.
- `put` replaces the whole record. Pass `ifVersion` to write only if nobody
  changed it since you read it; a mismatch throws `ConflictError`.
- `list` returns `{ data, meta: { nextCursor } }`; pass `nextCursor` back as
  `cursor` until it is null. Without `index` the most recently changed records
  come first. With `index` (a field declared under `indexes`) it takes one
  filter: `eq`, `prefix` (string indexes), or `gte` / `lte` (number and date
  indexes, inclusive). Filter further in your own code.
- A record is at most 64 KB, a key 1 to 128 of `A-Z a-z 0-9 . : _ -` (never a
  lone dot or two dots in a row). One customer holds at most `maxRows` records
  per collection: a write past it throws `CollectionFullError`. The account's
  plan caps the total (`TierLimitError`).
- These writes are real in test mode, and each environment has its own
  records. While the owner previews the app as a customer nothing is saved and
  the answer carries `simulated: true`.
- Do not store card data or passwords, and do not copy what the platform
  already holds.

## Marketplace sellers

On a package with the portal marketplace, the owner can let some customers
sell their own products through a portal app. The app declares a permission
whose grants are `products.own.read` and `products.own.write`; the owner gives
it to a portal role (a seller role they assign; a role customers pick at sign-up
is refused) on the app's page in the dashboard.

```ts
const me = mp.forRequest(request).me
const image = await me.media.upload(file, { fileName: file.name }) // a File or Blob carries its type
const draft = await me.products.create({ name: 'Kupa', price: 120, imageIds: [image.id] })
await me.products.submit(draft.id)
```

- Products start as drafts in the account's default language. `submit` sends
  one to the owner's team, which approves it before it goes live; when the
  owner turned review off, `submit` publishes at once. Show the seller
  `reviewStatus` (`pending`, `approved`, `rejected`) and `reviewNote`.
  Editing a draft that waits for the team withdraws it (`reviewStatus`
  becomes null), so the team never approves a version it did not see;
  `submit` again when the edit is done.
- An `update` of a live product under review applies `stock` and `trackStock`
  at once and holds the other fields in `pendingChanges`; the live version
  keeps selling until the team approves. `setVariants` on such a product
  answers `{ heldForReview: true }`. `unpublish` takes a product off the site
  and makes a waiting edit part of the draft.
- A seller sets only the fields of `SellerProductInput`: status, slug, tags and
  language are refused. Description and detail HTML is cleaned to a safe set
  of tags. `imageIds` takes only images the seller uploaded, and a tenant that
  limits sellers to some categories needs one of them as `categoryId`.
- `media.upload(bytes, { contentType })` sends the raw image (jpeg, png, webp,
  gif or avif, at most 10 MB). Pass an `idempotencyKey` to make it safe to
  retry; without one it is sent exactly once. A seller may keep 50 uploaded
  images that no product uses yet.
- A seller deletes only a product that is not live. Another seller's product,
  or one of the team's, answers 404. Writes count toward the owner's
  per-seller and account product limits (`TierLimitError`).
- These writes are real in test mode.

## Shared records

A collection declared with `"scope": "shared"` (see the `marcapony` CLI's
README) holds records that belong to the app, not to one customer. Read and
write it with the same calls as `me.records`:

```ts
const rates = mp.records<{ code: string; rate: number }>('rates')
const page = await rates.list({ index: 'code', eq: 'USD' })

// As the signed-in person: a `signed_in` collection, or a team member's write.
await mp.forRequest(request).records('menu').put('monday', { dish: 'Mercimek' })
```

- A `public` collection is readable without a signed-in person and without a
  grant. A `signed_in` one needs `forRequest(request)` and its read grant.
- A writer the collection does not list throws `PermissionDeniedError` with
  code `write_not_allowed`. `maxRows` caps the whole collection
  (`CollectionFullError`).
- Public reads can be up to a minute old.
- Never put personal data in a shared collection: every reader of the app sees
  it.

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

## Managing products

An `account` app with the `products:write` scope manages the catalog. So
does a team app, through `mp.forRequest(request)`, for a member given a
permission with the `products.write` grant (and `products.read` to list); the
member acts with their own role.

```ts
const draft = await mp.products.create({ name: 'Mug', price: 120, currency: 'TRY' })
await mp.products.update(draft.id, { stock: 12, trackStock: true })
await mp.products.publish(draft.id)
```

- `create` makes a draft in the account's default language. Publishing is its
  own call, `publish` / `unpublish`; `status` in a payload is a 400.
- `update` changes only the fields you send. Send `[]` to clear a list such as
  `tags`.
- Such an app also reads drafts and archived products, filters `list` by
  `status`, `createdVia` and `createdByCustomerId`, and sees where each product
  came from. Every other app sees published products only.
- Variants (with the variants plugin): read the axes with
  `mp.variantTypes.list()`, then set the whole list of combinations with
  `mp.products.setVariants(id, { combinations })`. A combination you leave
  out is removed, so start from `mp.products.variants(id)`.
- A write runs with the role and category limit of the member on a team app,
  else of the person who created the app's key, and creates count toward the
  account's product limit.

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

### Showing answers

An answer (`reply.text`, the `text` events of a stream, and the answers in
`chat.transcript()`) is Markdown. Characters write only a small subset: bold,
emphasis, strikethrough, inline code, links, bare URLs and one level of `-` or
`1.` lists. Shown as it is, a visitor sees `**Burger**` and
`[Burger](https://...)`, so render it:

```ts
import { personaMarkdownToText, renderPersonaMarkdown } from 'marcapony-sdk'

bubble.innerHTML = renderPersonaMarkdown(reply.text)
notify(personaMarkdownToText(reply.text)) // "Try the Burger (https://...)"
```

`renderPersonaMarkdown` escapes all text and turns only that subset into
HTML, so its output is safe to set as `innerHTML`. Headings, images, tables,
quotes and raw HTML stay as escaped text. A link opens in a new tab with
`rel="noopener noreferrer"`, and only http, https, mailto and tel links and
relative URLs become links; any other scheme, such as `javascript:`, shows just
the label. While a stream is running, render the whole text received so far
each time, not each piece. `personaMarkdownToText` strips the markup for
notifications, SMS or any place without HTML. In a browser bundle you can
import both from `marcapony-sdk/markdown`, which pulls in nothing else.

A React app may use `react-markdown` instead; keep raw HTML off (do not add
`rehype-raw`) and keep its default URL check.

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
