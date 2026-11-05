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

1. Checks `marcapony.json` with Marcapony, so a deploy it would refuse stops
   before anything is built.
2. Checks that nobody deployed to this environment since this project last
   synced with it (see [Working as a team](#working-as-a-team)).
3. Runs the `build` command from `marcapony.json`.
4. Saves the source and uploads the built backend and, if configured, the
   `assets` directory. Marcapony publishes it and supplies
   `MARCAPONY_API_KEY` / `MARCAPONY_API_URL` at runtime.
5. Waits until it is live, prints the address and records the new version in
   `marcapony.lock`.

When the platform reports the deploy as failed, the CLI prints `Deploy failed:`
with the reason and exits with a non-zero code; the version that was live keeps
serving. A deploy still running after
the wait prints its deployment id so you can check it later.

There is no `--env` flag: the target environment is derived from the key, so
deploying with the test key targets the test environment.

### Saving the source

Each deploy also saves the project source to Marcapony, so every version keeps
the code it was built from. The CLI prints one line about it:

```
Source saved: commit 1a2b3c4 (12 file(s))
```

or `Source not saved:` with the reason. Saving the source never stops a deploy:
if it fails, the deploy still goes live.

- Files ignored by `.gitignore` or `.marcaponyignore`, `node_modules`, the build
  output and credential files (`.dev.vars`, `.env`, keys) are never sent.
- If a scan finds something that looks like a secret key, the source is not
  saved and the CLI names the file and line (never the value).
- `--message <text>` stores a version message with the saved source.
- `--no-source` skips saving for one deploy. Set `MARCAPONY_SOURCE_PUSH=0` to
  skip it every time.

## Working as a team

Several people, CI and coding agents can deploy the same app. Nothing replaces
a change its author has not seen:

- `marcapony.lock` records, per environment, the version this project last
  synced with. It holds no secret. **Commit it** with the rest of your project,
  so a fresh checkout, CI and every agent share it.
- If someone deployed after your last sync, `marcapony app deploy` stops before
  the build and tells you who, with exit code 2. Run `marcapony app pull`, or
  `marcapony app deploy --force` to replace their changes (the dashboard shows
  that you did).
- `marcapony app pull` merges the newer version into your files. Files you did
  not touch are updated; files both sides changed are merged, and overlapping
  changes get git's conflict markers (`<<<<<<<`, `|||||||`, `=======`,
  `>>>>>>>`) with exit code 3. A deploy refuses files that still contain
  markers. `--patch` prints the changes instead of applying them, `--check`
  runs your build afterwards, and `--yes` merges into files with uncommitted
  changes without asking.
- `marcapony app status` shows the latest saved version, your base and the
  next command to run.

If your team keeps its code in its own git repository, that stays the source of
truth: when your files already contain a teammate's change, `pull` only moves
the base. Giving each developer or agent an environment of its own (for
example `test-ayse`) and meeting on `test` through pulls also works well.

## Scripts and agents

Every command takes `--json` and prints one JSON object on stdout (progress goes
to stderr). Commands never wait for input without a terminal. Exit codes:

| Code | Meaning                                                |
| ---- | ------------------------------------------------------ |
| 0    | Done                                                   |
| 1    | Error                                                  |
| 2    | The environment has changes this project has not pulled |
| 3    | A pull left conflicts to resolve                       |
| 4    | Refused by Marcapony; the message says why             |
| 5    | The project is not linked                              |

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

| Flag               | Meaning                                               |
| ------------------ | ----------------------------------------------------- |
| `--code <code>`    | Pairing code (link only; prompted when omitted)       |
| `--cwd <dir>`      | Project directory (defaults to the current directory) |
| `--message <text>` | Version message saved with the source (deploy only)   |
| `--no-source`      | Do not save the project source with this deploy       |
| `--force`          | Deploy over changes you have not pulled (deploy only) |
| `--patch`          | Print the remote changes as a patch (pull only)       |
| `--check`          | Run the build after a pull (pull only)                |
| `--yes`            | Never ask (pull only)                                 |
| `--json`           | Print the result as JSON                              |

Requires Node 20+ or Bun.

## License

Proprietary — free to install and run for building and deploying your own apps
on Marcapony, not to redistribute or fork. See [LICENSE.md](./LICENSE.md).
