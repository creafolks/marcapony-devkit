# marcapony-sdk

Official TypeScript client for the Marcapony external API (`/ext/v1`). Zero
runtime dependencies; runs anywhere `fetch` does (Cloudflare Workers, Node ≥20,
Bun, Deno).

## Install

```sh
bun add marcapony-sdk
```

## Quickstart

```ts
import { createClient } from 'marcapony-sdk'

const mp = createClient({ apiKey: process.env.MARCAPONY_API_KEY! })

const link = await mp.paymentLinks.create(
  {
    title: 'Order #1042',
    amount: 250,
    currency: 'TRY',
    lineItems: [{ name: 'Consultation', price: 250, quantity: 1 }],
    // Must be on one of the account's verified domains.
    successUrl: 'https://example.com/thanks',
  },
  // Derive this from the thing you are charging for, not from a fresh random —
  // a new value per attempt is what idempotency is meant to prevent.
  { idempotencyKey: 'order-1042' },
)
```

## Keys and scopes

Register your app under **My Apps** in the Marcapony admin, granting only the
scopes it needs (`payment-links:write`, `reservations:write`, ...), then run
`npx marcapony app link` in your project. The CLI exchanges a one-time pairing
code for an **app key** (`mpk_...`) and writes it into `.dev.vars` itself, so the
key never passes through a clipboard.

MCP keys (`mcp_`) cannot open this surface, and app keys cannot open MCP
sessions.

The client **refuses to run with a secret key in a browser** — a key in a
bundle is public. Call the API from your backend; pass
`dangerouslyAllowBrowser: true` only if you truly accept the exposure. Note
that `/ext/v1` also serves no CORS headers, so a browser call fails at the
platform level regardless.

## Errors

Every non-2xx response throws a typed subclass of `MarcaponyError` with
`status`, `code`, and `fields`:

```ts
import { InsufficientScopeError, ValidationError } from 'marcapony-sdk'

try {
  await mp.orders.create({ items: [{ productId, quantity: 1 }] })
} catch (err) {
  if (err instanceof InsufficientScopeError) {
    // the key needs orders:write
  }
  if (err instanceof ValidationError) {
    console.error(err.fields) // [{ field, message }]
  }
}
```

`tier_limit_exceeded` and `plugin_required` are permanent for the current
plan — do not retry them.

## Retries and idempotency

GETs retry automatically on 429/5xx/network errors (default 2 retries,
exponential backoff, honoring `Retry-After` up to 60s — a longer one is raised
as a `RateLimitError` for you to schedule). POSTs retry **only** when you pass
`{ idempotencyKey }` — the server replays the original response for the same
key for 48h, so a retry that reaches a _completed_ request is safe.

The replay record is written after the request completes, so a retry sent while
the first attempt is still in flight (a client timeout, a dropped connection)
can still execute twice. Use a stable idempotency key and a timeout comfortably
longer than the operation, and reconcile on your side for money movement.

## Options

| Option       | Default                            |                                                               |
| ------------ | ---------------------------------- | ------------------------------------------------------------- |
| `baseUrl`    | `https://api.marcapony.com/ext/v1` | Point at `https://staging-api.marcapony.com/ext/v1` for tests |
| `timeoutMs`  | `30000`                            | Per-request timeout                                           |
| `maxRetries` | `2`                                | Idempotent requests only                                      |
| `fetch`      | `globalThis.fetch`                 | Override for tests/instrumentation                            |
| `appId`      | none                               | `env.MARCAPONY_APP_ID`; needed by `identity()`                |

## Signed-in visitors (portal apps)

An app placed in the customer portal (`"placement": "portal"` in
`marcapony.json`) receives a short-lived signed identity on every request from
a signed-in visitor. Read it with `identity()`, and make every call on the
visitor's behalf through `forRequest()`:

```ts
import { createClient } from 'marcapony-sdk'

export default {
  async fetch(request: Request, env: Env) {
    const mp = createClient({
      apiKey: env.MARCAPONY_API_KEY,
      baseUrl: env.MARCAPONY_API_URL,
      appId: env.MARCAPONY_APP_ID,
    })

    const who = await mp.identity(request) // null when nobody is signed in
    if (!who) return new Response('Please sign in', { status: 401 })

    // Only this visitor's own records; the platform forces the customer.
    const bookings = await mp.forRequest(request).me.reservations.list()
    return Response.json({ email: who.email, canBook: who.can('book'), bookings })
  },
}
```

- `identity()` is for display and for hiding buttons. The platform enforces
  access itself on every `forRequest()` call, so a wrong answer there can only
  show the wrong UI, never someone else's data.
- `who.permissions` lists the permission ids from your `marcapony.json` that
  the owner granted this person; `who.can(id)` checks one.
- `forRequest(request).me` offers `profile.get`,
  `reservations.list/get/create/cancel` (with `status`, `from` and `to`
  filters and the deposit state), `orders.list/get`, `paymentLinks.list/get`
  and `formSubmissions.list` (which forms were sent and when, never the
  answers). Each call is limited to the visitor by the platform; another
  customer's id answers 404.
- A portal app serving customers cannot read customer data with its plain
  client at all: without an identity those calls answer 403
  `identity_required` (`PermissionDeniedError`), even when the key holds the
  scope. The plain client still reads the catalog (site, products, business)
  and can book or send a form for an anonymous visitor.
- Create the scoped client per request and never keep it, or what it
  returned, in module scope: one worker serves many visitors.
- Never read, log or forward the `x-marcapony-identity` header or the portal
  session cookie yourself. The platform removes the cookie before your app runs.

### Team tools

A team member who opens the app from the dashboard (**Araçlarım**, or **Test
et** on the app's page) gets an identity with `kind: 'member'`. A member acts
for the account, so a team tool uses the account groups of `forRequest()`
instead of `me`:

```ts
const who = await mp.identity(request)
if (who?.kind === 'member') {
  const team = mp.forRequest(request)
  const today = await team.reservations.list()
  await team.reservations.updateStatus(id, { status: 'approved' })
}
```

`forRequest(request)` offers `reservations.list/get/create/updateStatus`,
`orders.list/get` and `customers.list/get` for a member. The platform narrows
each call to the key's scopes, the permissions the owner granted and the
member's own role, so a viewer cannot write through a tool an admin built. A
customer's identity is refused on these routes, and an app is either
customer-facing or a team tool, never both: the dashboard sets which one
(`dataAccess` `customer` or `team`), and the platform refuses the other kind of
identity. `forRequest(request).kind` tells you which kind the request carries.

When `who.preview` is true the owner is previewing the app, and the platform
simulates every write. Show a banner rather than claim a change was saved.

## Data access

Every app declares whose data it works with (`dataAccess` in `marcapony.json`,
set in the dashboard):

| `dataAccess` | Placement | Plain client (no identity)                                      |
| ------------ | --------- | --------------------------------------------------------------- |
| `account`    | site      | every route its scopes allow (integrations, back-office tools)  |
| `visitor`    | site      | catalog reads, bookings and form entries for anonymous visitors |
| `customer`   | portal    | the same as `visitor`; `me.*` through `forRequest()`            |
| `team`       | portal    | the same as `visitor`; account groups through `forRequest()`    |

A deploy can only narrow it (`account` to `visitor`, or choose `customer` or
`team` when moving into the portal). Widening is done in the dashboard.

## Amounts are computed server-side

Order line costs are always derived from the catalog on the server; the API
accepts product references and quantities, never client-declared costs.

Payment links are the deliberate exception — they accept a free amount, because
the thing being charged for is not always a catalog item. That is exactly why a
key with `payment-links:write` must live on your backend and never reach a
browser.

## License

Proprietary — free to install, bundle into your own applications, and ship those
applications anywhere; not to republish as a standalone package. See
[LICENSE.md](./LICENSE.md).
