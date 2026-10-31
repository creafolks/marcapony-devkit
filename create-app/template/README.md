# Marcapony app

A small web app with its own backend, connected to your Marcapony account.

Requires [Bun](https://bun.sh): the dev server (`scripts/dev.ts`) runs on it.

## Get a key

```sh
bun install
bun run link
```

Create the app under **My Apps** in your Marcapony dashboard, generate a
connection code there, and paste it when asked. The key is written into
`.dev.vars` for you. It is never shown and never goes through your clipboard.
An `AGENTS.md` is written too, listing exactly what this app is allowed to do, so
your AI assistant knows what it can build.

`bun run link` and `bun run deploy` use the Marcapony CLI pinned in this
project's `devDependencies`, so every machine runs the same version.

## Develop

```sh
bun run dev
```

Your interface and your `/api` routes both run locally.

One thing to know: local development and the published app run in slightly
different environments. Stick to standard web APIs in `src/server` (`fetch`,
`Request`, `Response`, `crypto`), since those behave identically in both, and
check the published app after you change something on the backend.

Locally there is no app id (`MARCAPONY_APP_ID` is set by the platform at deploy)
and no signed-in visitor, so `identity()` is always null in local dev.

## Publish

```sh
bun run deploy
```

That builds your app, publishes it, and prints its address. Marcapony hosts it
and supplies the key and the app id at runtime; there is nothing for you to
configure.

## Layout

| Path                      | What it is                                  |
| ------------------------- | ------------------------------------------- |
| `src/server/index.ts`     | Your backend. Handles `/api/*`              |
| `src/server/marcapony.ts` | The only place that talks to Marcapony      |
| `src/ui/`                 | Your interface                              |
| `marcapony.json`          | How Marcapony builds and publishes your app |
| `.dev.vars`               | Your key. Never commit it                   |

## Rules that matter

- **The key stays on the backend.** Your interface calls your own `/api` routes,
  and those routes call Marcapony. A key sent to the browser is a public key.
- **Pass an `idempotencyKey` to every create call.** Retries then cannot create
  the same order, reservation, or payment link twice.
- **Apps keep no storage of their own.** Anything that has to persist lives in
  Marcapony, which your key already reaches.
