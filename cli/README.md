# marcapony

The Marcapony CLI. Connects a project to your Marcapony app and publishes it.
Marcapony does the hosting; there is nothing for you to set up.

```bash
npx marcapony app link
npx marcapony app deploy
```

## `marcapony login`

Log in once from your machine instead of keeping a deploy key in every project:

```bash
npx marcapony login            # shows a code; approve it in the dashboard and pick the business
npx marcapony app link         # no pairing code: pick the app and environment
npx marcapony app deploy       # uses your login
```

- The login is kept in the system keychain (macOS Keychain, Windows Credential
  Manager, or the Secret Service on Linux), never in a project. It works in the
  business you picked when you approved it; log in again with
  `--account <slug>` for another one. Unused for 90 days, it expires.
- A project linked this way gets `.marcapony/project.json` (the app and
  environment, no secret; commit it) and a key in `.env.local` that your app
  uses in local development. That key can read and write the environment's
  data but cannot deploy or read the source.
- `marcapony app link --refresh` moves a project linked with a pairing code to
  your login and revokes its old deploy key.
- `marcapony login status` lists your logins and says what the current folder
  deploys with. `marcapony logout` revokes a login; so does "İptal et" under
  Settings > Security in the dashboard.
- No keychain (a server or container): use `MARCAPONY_API_KEY` from
  `marcapony app link --ci`, or `marcapony login --insecure-file` to keep the
  login in a file only you can read.

Which credential a command uses: `MARCAPONY_API_KEY` from the environment
first, then your login for a project linked with it, then the deploy key in
`.env.local`.

### Releases from the terminal

```bash
npx marcapony app release              # test's live version to production
npx marcapony app release list
npx marcapony app rollback 3
npx marcapony app release retry 4
```

`release` shows the changes and anything that blocks the release, asks you to
confirm (`--yes` skips the prompt; a version with warnings also needs
`--acknowledge-warnings`), and waits until the release is live. These
commands need your login: an app key, even one for production, cannot take a
version live.

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

### Keys and renewal

A key lasts 90 days. Linking again with a new pairing code renews it: the new
key is written first, then your earlier key for the same environment is
revoked, so a project never holds more than one live key of yours. Keys made by
teammates and keys made with `--ci` are not touched. Keys made before 0.7.0
carry no label and are not revoked by a re-link either; revoke them from the
app's page in the dashboard. From 14 days before the expiry, every deploy
prints a warning with the command to run.

For a CI pipeline, link with `--ci`:

```bash
npx marcapony app link --code mpl_… --ci
```

The key is labelled "CI" in the dashboard and linking it revokes nothing, so
several pipelines can each have one. Store it in the pipeline's secret store as
`MARCAPONY_API_KEY` and remove it from your machine. The app's page in the
dashboard lists every CLI key of the environment, who made it, when it was last
used and when it expires, and revokes any of them.

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

The commit carries a `Bundle-Hash` trailer, the sha256 of the bundle the deploy
uploads, so the platform can check that a version's code and bundle belong
together before it releases that version to production.

- Files ignored by `.gitignore` or `ignore` in `marcapony.json`, `node_modules`,
  the build output and credential files (`.env.local`, `.dev.vars`, keys) are
  never sent.
- Before saving, the files are scanned for secrets: API keys of common
  providers (payment, cloud, AI, source hosting), private keys, tokens with a
  private role, and quoted high-entropy values assigned to names such as
  `secret`, `token` or `password`. On a finding the source is not saved and the
  CLI prints `path:line`, the rule and the first four characters of the value.
  The deploy itself goes on.
- A test value can be allowed with a `marcapony-scan: allow` comment on its
  line or the line above. Allowed matches are still listed. Files named
  `*.test.*` or under `__fixtures__/` are exempt from the high-entropy rule, never
  from the provider patterns. Marcapony scans the saved source again on its
  side, where the comment only exempts the high-entropy rule.
- `npx marcapony scan` runs the same scan alone over the same files, for a
  pre-commit hook or a CI step.
- `--message <text>` stores a version message with the saved source.
- `--no-source` skips saving for one deploy. Set `MARCAPONY_SOURCE_PUSH=0` to
  skip it every time.

#### The size limit

Each app's saved source may use up to 50 MB: the files of every environment's
latest version, each counted once. After a push the CLI prints the usage as last
measured:

```
Source repo: 12.4 / 50 MB (37.6 MB left)
```

At or over the limit, a deploy that saves source is refused with exit code 4
and both numbers; push a version without the large files (the push itself is
always accepted), or deploy with `--no-source`. Right after such a push the
platform measures the repo again, and the CLI waits for it. Directories such as
`node_modules`, `.git` and `.wrangler`, and credential files, are never saved:
the platform blocks a version that contains them, however it was pushed.

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
- When the app's production goes live through releases (a version tested in
  the test environment is promoted with **Canlıya al** in the dashboard), a
  deploy with the production key is refused with exit code 4. For a hotfix,
  the owner allows one direct deploy on the app page; it is valid for 30
  minutes, and `marcapony app deploy --direct` uses it.
- `marcapony app pull` merges the newer version into your files. Files you did
  not touch are updated; files both sides changed are merged, and overlapping
  changes get git's conflict markers (`<<<<<<<`, `|||||||`, `=======`,
  `>>>>>>>`) with exit code 3. A deploy refuses files that still contain
  markers. `--patch` prints the changes instead of applying them, `--check`
  runs your build afterwards, and `--yes` merges into files with uncommitted
  changes without asking.
- `marcapony app status` shows the latest saved version, your base and the
  next command to run.

### Starting from the saved source

`marcapony app clone <dir> --code <code>` clones an environment's saved source
into a new or empty directory and links it, with a pairing code from the app
page. The clone is ready to edit and deploy, and its commit is the base in
`marcapony.lock`. The read token is handed to git only; it is never printed or
written to a file. A version the platform's scan blocked is not cloned. A
project that is already a git clone of the environment's branch takes its
checked-out commit as the base after `marcapony app link`.

### Changes handed over from the dashboard

An app's owner can set its changes from the dashboard (for example ones the
AI assistant proposed) to be handed over to the developers instead of being
saved on the environment. An approved change then waits for you:

```bash
marcapony app proposals list
marcapony app proposals pull <id>
```

`proposals pull` merges the change into your files the same way as
`marcapony app pull`, with the same conflict markers, exit code 3 and `--yes`,
but it does not move the base in `marcapony.lock`. Check that it builds, commit
it to your own git and deploy: the deploy that contains the change closes it in
the dashboard.

If your team keeps its code in its own git repository, that stays the source of
truth: when your files already contain a teammate's change, `pull` only moves
the base. Giving each developer or agent an environment of its own (for
example `test-ayse`) and meeting on `test` through pulls also works well.

## Settings and secrets

An app often needs values of its own, such as a payment provider's key or a
webhook address. Set them per environment, in the dashboard or from the CLI;
the app reads them from `env`, like `MARCAPONY_API_KEY`.

```bash
marcapony app env set IYZICO_API_KEY --secret   # asks for the value, hidden
echo "https://example.com/hook" | marcapony app env set BOOKING_WEBHOOK_URL
marcapony app env list [--show]
marcapony app env delete BOOKING_WEBHOOK_URL
```

- A value is never taken from the command line, so it stays out of your shell
  history: type it at the hidden prompt or pipe it in.
- A secret is never shown again; `list --show` prints settings only.
- A change reaches the running app at once, without a deploy.
- Names use capital letters, digits and underscores; `MARCAPONY_` is reserved.
  An environment holds up to 50 values of up to 5 KiB each.
- For local development, keep your own values in your local env file. Nothing
  downloads secrets.

## Scripts and agents

Every command takes `--json` and prints one JSON object on stdout (progress goes
to stderr). Commands never wait for input without a terminal.

When `pull` or `proposals pull` leaves conflicts, the JSON lists them under
`conflicts.files`. Each file has its `regions`, and each region has an `id` and
the full text of `base`, `ours` (your files) and `theirs` (the incoming
version). A side is `null` when the file does not exist there. A binary file is
listed with `"binary": true` and no regions, and is left as it was.

Exit codes:

| Code | Meaning                                                |
| ---- | ------------------------------------------------------ |
| 0    | Done                                                   |
| 1    | Error                                                  |
| 2    | The environment has changes this project has not pulled |
| 3    | A pull left conflicts to resolve                       |
| 4    | Refused by Marcapony; the message says why             |
| 5    | The project is not linked                              |
| 6    | `marcapony scan` found possible secrets                |
| 7    | Not logged in, or the login expired or was revoked     |

## Configuration reference

`marcapony.json` says what the app needs; Marcapony turns it into the runtime
settings. `npx marcapony app link` writes it for a new project, and
`npx marcapony app migrate-config` moves an older file to this format.

| Field                | Required | Meaning                                                                         |
| -------------------- | -------- | ------------------------------------------------------------------------------- |
| `manifest`           | yes      | The format version, `2`                                                         |
| `app`                | yes      | App slug issued by the platform (written by `link`)                             |
| `build`              | yes      | Build command run before every deploy                                           |
| `server`             | no       | The built server module (default `dist/server/index.js`), exporting `{ fetch }` |
| `public.dir`         | no       | The built public files (default `dist/client`, when it exists)                  |
| `public.ignore`      | no       | Files in the public directory that are never uploaded                           |
| `routes.server`      | no       | Paths that always reach the server first, such as `/api/*`                      |
| `routes.notFound`    | no       | `spa` (serve `index.html`), `page` (serve `404.html`) or `none`                 |
| `runtime`            | no       | The Marcapony runtime version, such as `2026-10` (default: the oldest)          |
| `ignore`             | no       | Files never saved with the source, in `.gitignore` syntax; `!` re-includes      |
| `env`                | no       | Settings and secrets the app needs: `{ "NAME": { "secret", "required", "description" } }` |
| `placement`          | no       | `portal` (behind the customer portal login) or `public`                         |
| `dataAccess`         | no       | Whose data the app works with: `account`, `visitor`, `customer` or `team`       |
| `permissions`        | no       | Permissions the app offers (`id`, `label`, `grants`); the owner assigns them    |
| `portal`             | no       | Portal menu entry: `title`, `icon`, `sortOrder`                                 |

Add `"$schema": "./node_modules/marcapony/manifest.schema.json"` for completion
in your editor. Projects linked before this format keep working unchanged.

The source ignore rules apply in this order, and a later one can re-include
with `!` what an earlier one excluded: your `.gitignore` files and
`.git/info/exclude`, then `ignore` in `marcapony.json`. Dependencies, the
build output and credential files are never saved, whatever the rules say.
`npx marcapony app source --dry-run` lists what the next deploy saves and why
each other file is skipped.

The app runs in the Marcapony runtime: a standard fetch handler, no file
system at request time and limited CPU time per request. Prefer web APIs
(`fetch`, `Request`, `Response`, `crypto`) over Node built-ins.

Published apps keep **no storage of their own** — a bundle may not declare
storage bindings. Anything that has to persist lives in Marcapony, which the
supplied key already reaches.

## Options

| Flag               | Meaning                                               |
| ------------------ | ----------------------------------------------------- |
| `--code <code>`    | Pairing code (link only; prompted when omitted)       |
| `--ci`             | Make a key for a CI pipeline (link only)              |
| `--cwd <dir>`      | Project directory (defaults to the current directory) |
| `--message <text>` | Version message saved with the source (deploy only)   |
| `--no-source`      | Do not save the project source with this deploy       |
| `--force`          | Deploy over changes you have not pulled (deploy only) |
| `--direct`         | Use a one-time direct deploy allowed on the app page (deploy only) |
| `--patch`          | Print the remote changes as a patch (pull only)       |
| `--check`          | Run the build after a pull (pull only)                |
| `--yes`            | Never ask (pull and proposals pull)                   |
| `--json`           | Print the result as JSON                              |

Requires Node 20+ or Bun.

## License

Proprietary — free to install and run for building and deploying your own apps
on Marcapony, not to redistribute or fork. See [LICENSE.md](./LICENSE.md).
