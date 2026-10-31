# Marcapony app: shop

A small public shop: the product list with a category filter, a cart kept in
the visitor's browser, and a checkout that creates a payment link and sends the
buyer to pay.

## Set up in the dashboard

Create the app under **My Apps** with:

- **Placement:** public (`"placement": "public"`)
- **Data access:** account. Creating a payment link is not available to visitor
  apps, so set this in the dashboard; a deploy cannot widen it.
- **Scopes:** `products:read`, `site:read`, `payment-links:write`. Grant nothing
  else: with account data access, the key reaches everything its scopes allow.
- **Plugin:** the account needs payment links enabled
- **Permissions:** none

## Routes

| Route                 | What it does                                                    |
| --------------------- | --------------------------------------------------------------- |
| `GET /api/catalog`    | Shop name, categories and products (`?category=<slug>` filters) |
| `POST /api/checkout`  | `{ attemptId, items: [{ productId, quantity }] }` → total and pay link |

The browser sends only product ids and quantities. The server reads every
product again, uses its sale price when it has one, checks stock and computes
the total itself. The buyer pays at `/pay/<linkId>` on the business's site.

## What to change first

1. The product view in `src/ui/App.tsx` (images, descriptions, layout).
2. Add a `successUrl` to the payment link in `src/server/index.ts` if buyers
   should return somewhere after paying; it must be on one of the account's
   verified domains.
3. If the business ships goods, collect an address before checkout.

## Develop and publish

Requires [Bun](https://bun.sh).

```sh
bun install
bun run link     # paste the connection code from the app's page; writes .dev.vars and AGENTS.md
bun run dev      # interface and /api routes on your machine
bun run deploy   # build and publish; prints the address
```

`.dev.vars` holds the app key. Never commit it, and never send it to the
browser: the interface calls this app's own `/api` routes, and only those talk
to Marcapony. `MARCAPONY_APP_ID` is set by Marcapony when the app is deployed;
locally there is none, so nobody is signed in during `bun run dev`.

New apps start in test mode: writes are simulated until you switch test mode off
on the app's page. Pass an `idempotencyKey` to every create call so a retry
cannot create the same thing twice.
