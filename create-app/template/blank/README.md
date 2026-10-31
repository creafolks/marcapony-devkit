# Marcapony app: blank

A small starting point with its own backend. As an example it lists the
account's products.

## Set up in the dashboard

Create the app under **My Apps** with:

- **Placement:** public (`placement` is not set in `marcapony.json`)
- **Data access:** visitor
- **Scopes:** `products:read`
- **Permissions:** none

## Routes

| Route               | What it does                       |
| ------------------- | ---------------------------------- |
| `GET /api/health`   | Answers `{ "ok": true }`           |
| `GET /api/products` | The first 12 products of the account |

## What to change first

1. Replace the products example in `src/server/index.ts` and `src/ui/App.tsx`
   with what the app is for.
2. Enable the scopes the new calls need, then run `bun run link` again so
   `AGENTS.md` lists them.
3. Set the page title in `index.html`.

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
