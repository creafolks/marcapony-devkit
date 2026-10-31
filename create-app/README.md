# create-marcapony-app

Creates a new Marcapony app — a small web app with its own backend, already
connected to your Marcapony account.

```sh
npx create-marcapony-app my-app
cd my-app
bun install
npx marcapony app link
bun run dev
```

When it is ready:

```sh
npx marcapony app deploy
```

Marcapony hosts it. There is nothing to set up and no other account to sign up
for.

## What you get

| Path                      | What it is                                  |
| ------------------------- | ------------------------------------------- |
| `src/server/index.ts`     | Your backend. Handles `/api/*`              |
| `src/server/marcapony.ts` | The only place that talks to Marcapony      |
| `src/ui/`                 | Your interface                              |
| `marcapony.json`          | How Marcapony builds and publishes your app |

`npx marcapony app link` puts your app key in place and writes an `AGENTS.md`
listing exactly what this app is allowed to do — so an AI assistant can pick the
project up and start building on it.

## Options

| Flag      | Meaning                                               |
| --------- | ----------------------------------------------------- |
| `--force` | Write into the directory even if it already has files |
| `-h`      | Help                                                  |

Run without a directory name and it asks for one.

Requires Node 20 or newer, or Bun. No runtime dependencies.

## License

Proprietary tool, unrestricted output — the app it creates is yours to license
and ship however you like. See [LICENSE.md](./LICENSE.md).
