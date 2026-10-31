# create-marcapony-app

Creates a new Marcapony app — a small web app with its own backend, already
connected to your Marcapony account.

```sh
npx create-marcapony-app my-app
cd my-app
bun install
bun run link
bun run dev
```

When it is ready:

```sh
bun run deploy
```

`bun run link` and `bun run deploy` run the Marcapony CLI (`marcapony`), which
the new project pins in its `devDependencies`.

Marcapony hosts it. There is nothing to set up and no other account to sign up
for.

## What you get

| Path                      | What it is                                  |
| ------------------------- | ------------------------------------------- |
| `src/server/index.ts`     | Your backend. Handles `/api/*`              |
| `src/server/marcapony.ts` | The only place that talks to Marcapony      |
| `src/ui/`                 | Your interface                              |
| `marcapony.json`          | How Marcapony builds and publishes your app |

`bun run link` puts your app key in place and writes an `AGENTS.md`
listing exactly what this app is allowed to do — so an AI assistant can pick the
project up and start building on it.

## Options

| Flag      | Meaning                                               |
| --------- | ----------------------------------------------------- |
| `--force` | Write into the directory even if it already has files |
| `-h`      | Help                                                  |

Run without a directory name and it asks for one.

The scaffolder runs on Node 20 or newer and has no runtime dependencies. The app
it creates needs [Bun](https://bun.sh): its dev server runs on Bun.

## License

Proprietary tool, unrestricted output — the app it creates is yours to license
and ship however you like. See [LICENSE.md](./LICENSE.md).
