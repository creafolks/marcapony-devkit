# marcapony

The Marcapony CLI. Connects a project to your Marcapony app and publishes it.
Marcapony does the hosting; there is nothing for you to set up.

```bash
npx marcapony app link
npx marcapony app deploy
```

## `marcapony app link`

Run once per project. Generate a one-time pairing code on the app's page in your
Marcapony dashboard, then:

```bash
npx marcapony app link --code mpl_…
```

The code is exchanged for a freshly minted key for the app's **test**
environment. The CLI writes it directly into `.dev.vars`:

```
MARCAPONY_API_KEY=mpk_…
MARCAPONY_API_URL=https://api.marcapony.com/ext/v1
```

Raw keys never travel through a clipboard and are never printed. Existing
`.dev.vars` lines and comments are preserved. `.dev.vars` is added to `.gitignore`
when it is not ignored yet; never commit it.

It also creates `marcapony.json`:

```jsonc
{
  "app": "my-app",
  "build": "bun run build",
  "worker": "dist/worker/index.js",
  "assets": "dist/client",
}
```

An existing `marcapony.json` is never overwritten — only missing fields are
filled in.

## `marcapony app deploy`

```bash
npx marcapony app deploy
```

1. Runs the `build` command from `marcapony.json`.
2. Reads the built backend and, if configured, the `assets` directory.
3. Uploads it to Marcapony, which publishes it and supplies
   `MARCAPONY_API_KEY` / `MARCAPONY_API_URL` at runtime.
4. Waits until it is live, then prints the address.

When the platform reports the deploy as failed, the CLI prints `Deploy failed:`
with the reason and exits with a non-zero code; the version that was live keeps
serving. A deploy still running after
the wait prints its deployment id so you can check it later.

There is no `--env` flag: the target environment is derived from the key, so
deploying with the test key targets the test environment.

## Configuration reference

| Field                | Required | Meaning                                                                      |
| -------------------- | -------- | ---------------------------------------------------------------------------- |
| `app`                | yes      | App slug issued by the platform                                              |
| `build`              | yes      | Build command run before bundling                                            |
| `worker`             | yes      | Path to the built backend entry (an ES module)                               |
| `assets`             | no       | Directory of static assets to serve                                          |
| `assetsConfig`       | no       | Static-asset behaviour (e.g. single-page-app fallback)                       |
| `compatibilityDate`  | no       | Runtime compatibility date                                                   |
| `compatibilityFlags` | no       | Runtime compatibility flags                                                  |
| `placement`          | no       | `portal` (behind the customer portal login) or `public`                      |
| `dataAccess`         | no       | Whose data the app works with: `account`, `visitor`, `customer` or `team`    |
| `permissions`        | no       | Permissions the app offers (`id`, `label`, `grants`); the owner assigns them |
| `portal`             | no       | Portal menu entry: `title`, `icon`, `sortOrder`                              |

Published apps keep **no storage of their own** — a bundle may not declare
storage bindings. Anything that has to persist lives in Marcapony, which the
supplied key already reaches.

## Options

| Flag            | Meaning                                               |
| --------------- | ----------------------------------------------------- |
| `--code <code>` | Pairing code (link only; prompted when omitted)       |
| `--cwd <dir>`   | Project directory (defaults to the current directory) |

Requires Node 20+ or Bun.

## License

Proprietary — free to install and run for building and deploying your own apps
on Marcapony, not to redistribute or fork. See [LICENSE.md](./LICENSE.md).
