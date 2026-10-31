# marcapony-sdk

Official TypeScript client for the Marcapony external API (`/ext/v1`). Zero
runtime dependencies; runs anywhere `fetch` does (Cloudflare Workers, Node ≥20,
Bun, Deno).

## Install

```sh
npm install marcapony-sdk@~0.7.0
```

The SDK is 0.x, so a minor release may contain breaking changes. Pin a minor
range (`~0.7.0`) and read [CHANGELOG.md](./CHANGELOG.md) before upgrading.

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

## License

Proprietary: free to install, bundle into your own applications, and ship those
applications anywhere; not to republish as a standalone package. See
[LICENSE.md](./LICENSE.md).
