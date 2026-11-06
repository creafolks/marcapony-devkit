#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { CliError, EXIT } from './api.js'
import { runDeployDetailed } from './deploy.js'
import { runLink } from './link.js'
import { runGuide } from './guide.js'
import { runPull } from './pull.js'
import { runStatus } from './status.js'
import { readHidden, readStdin, runEnvDelete, runEnvList, runEnvSet } from './env.js'
import { runMigrateConfig } from './migrate.js'
import { runSourceDryRun } from './source-command.js'
import { runScan } from './scan.js'

export { runLink } from './link.js'
export { runDeploy, runDeployDetailed } from './deploy.js'
export { runGuide } from './guide.js'
export { runPull } from './pull.js'
export { runStatus } from './status.js'
export { runEnvDelete, runEnvList, runEnvSet } from './env.js'
export { migrateConfig, runMigrateConfig } from './migrate.js'
export { runSourceDryRun } from './source-command.js'
export { runScan } from './scan.js'
export * from './scan-rules.js'
export * from './lock.js'
export * from './merge.js'
export * from './config.js'
export * from './api.js'
export * from './assets.js'
export * from './agents.js'

// Kept in step with cli/package.json by a test — `marcapony --version` is the
// first thing a bug report quotes, so it must not drift from what was shipped.
const VERSION = '0.6.0'

const USAGE = `marcapony — build and deploy Marcapony apps

Usage
  marcapony app link [--code <code>] [--ci] [--cwd <dir>]
  marcapony app deploy [--cwd <dir>] [--message <text>] [--no-source] [--force] [--json]
  marcapony app status [--cwd <dir>] [--json]
  marcapony app pull [--cwd <dir>] [--patch] [--check] [--yes] [--json]
  marcapony app env list [--show] [--json]
  marcapony app env set <NAME> [--secret]     (value from a hidden prompt or stdin)
  marcapony app env delete <NAME>
  marcapony app source --dry-run [--json]
  marcapony app migrate-config
  marcapony scan [--cwd <dir>] [--json]
  marcapony guide [--cwd <dir>]

Commands
  app link     Exchange a one-time pairing code for this project's environment
               key. Writes .env.local, marcapony.json and AGENTS.md. Get the code
               from the app's page in your Marcapony dashboard. Keys last 90
               days; linking again renews the key and revokes your earlier one
               for the environment. With --ci the key is labelled for a
               pipeline: store it in the pipeline's secret store as
               MARCAPONY_API_KEY, and earlier keys stay valid.
  app deploy   Run the project's build, upload the bundle, and wait until it is
               live. The target environment comes from the key — there is no
               --env flag. The project source is saved with each deploy;
               --no-source skips that for one run, and
               MARCAPONY_SOURCE_PUSH=0 skips it every time. If someone
               deployed after this project's last sync, it stops before the
               build: pull first, or pass --force to replace their changes.
  app status   The environment's latest saved source, this project's base
               (marcapony.lock) and the next command to run.
  app pull     Merge the environment's newer changes into your files. Conflicts
               get git's diff3 markers. Updates marcapony.lock; commit that
               file so teammates, CI and agents share the base.
  app env      The environment's own settings and secrets, injected into the
               app as env values on every deploy and applied at once to the
               running app. A value is never taken from the command line:
               type it at the hidden prompt or pipe it in. Secrets are never
               shown again.
  app source   With --dry-run, list the files the next deploy saves and the
               rule that skipped each other one.
  app migrate-config
               Rewrite marcapony.json to the current format and print what
               changed.
  scan         Run the secret scan alone over the files a deploy would save,
               for a pre-commit hook or CI. Prints path:line, the rule and the
               first four characters of the value. A line with a
               "marcapony-scan: allow" comment, or the line below it, is
               allowed and still listed.
  guide        Print the AI-readable setup guide for this project (the same
               content written to AGENTS.md), listing the SDK calls and schemas
               your app key can use.

Options
  --code <code>     Pairing code (link only; prompted when omitted)
  --ci              Make a key for a CI pipeline (link only)
  --cwd <dir>       Project directory (defaults to the current directory)
  --message <text>  Version message saved with the source (deploy only)
  --no-source       Do not save the project source with this deploy
  --force           Deploy even though the environment has changes you have not
                    pulled; they are replaced, and the panel shows who did it
  --patch           Print the remote changes as a patch instead of applying them
  --check           Run the project's build after a pull
  --yes             Never ask; merge into files with uncommitted changes
  --secret          Store the value as a secret (env set only)
  --show            Print setting values (env list only; secrets never)
  --json            Print the result as JSON (for scripts and agents)
  -h, --help        Show this help
  -v, --version     Show the CLI version

Exit codes
  0 done, 1 error, 2 the environment has changes to pull, 3 conflicts to
  resolve, 4 refused by the platform, 5 project not linked, 6 the secret
  scan found possible secrets
`

export interface ParsedArgs {
  command: string[]
  flags: Record<string, string | boolean>
}

// Flags that never take a value, so the word after them stays a command or flag.
const BOOLEAN_FLAGS = new Set([
  'help',
  'h',
  'version',
  'v',
  'no-source',
  'force',
  'patch',
  'check',
  'yes',
  'json',
  'secret',
  'show',
  'dry-run',
  'ci',
])

export function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('-')) {
      command.push(arg)
      continue
    }
    const name = arg.replace(/^--?/, '')
    const next = argv[i + 1]
    if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith('-')) {
      flags[name] = next
      i++
    } else {
      flags[name] = true
    }
  }

  return { command, flags }
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

export async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv)

  if (flags.version || flags.v) {
    console.log(VERSION)
    return 0
  }
  if (flags.help || flags.h || command.length === 0) {
    console.log(USAGE)
    return 0
  }

  const [namespace, action] = command
  const cwd = stringFlag(flags, 'cwd') ?? process.cwd()
  // Hidden, undocumented team escape hatch: point the CLI at a non-production
  // API (local | staging | production). Not shown in --help; end users only
  // ever reach production. Arbitrary URLs are intentionally not accepted.
  const cliEnv = stringFlag(flags, 'cli-env')

  try {
    if (namespace === 'guide') {
      await runGuide({ cwd, cliEnv, env: process.env })
      return 0
    }
    if (namespace === 'app' && action === 'link') {
      await runLink({
        cwd,
        cliEnv,
        code: stringFlag(flags, 'code'),
        ci: flags.ci === true,
        env: process.env,
      })
      return 0
    }
    const json = flags.json === true
    // With --json, progress goes to stderr so stdout is one JSON document.
    const log = json ? (m: string) => console.error(m) : (m: string) => console.log(m)
    if (namespace === 'scan') {
      const result = runScan({ cwd, log })
      if (json) console.log(JSON.stringify({ ok: result.findings.length === 0, ...result }))
      return result.findings.length > 0 ? EXIT.secretsFound : EXIT.ok
    }
    if (namespace === 'app' && action === 'deploy') {
      const result = await runDeployDetailed({
        cwd,
        cliEnv,
        env: process.env,
        log,
        message: stringFlag(flags, 'message'),
        source: flags['no-source'] !== true,
        force: flags.force === true,
        checkKeyExpiry: true,
      })
      if (json) console.log(JSON.stringify({ ok: true, ...result }))
      return EXIT.ok
    }
    if (namespace === 'app' && action === 'status') {
      const result = await runStatus({ cwd, cliEnv, env: process.env, log })
      if (json) console.log(JSON.stringify({ ok: true, ...result }))
      return result.state === 'behind' || result.state === 'not_synced'
        ? EXIT.remoteChanges
        : EXIT.ok
    }
    if (namespace === 'app' && action === 'pull') {
      const interactive = !json && process.stdin.isTTY === true && process.stdout.isTTY === true
      const result = await runPull({
        cwd,
        cliEnv,
        env: process.env,
        log,
        yes: flags.yes === true,
        patch: flags.patch === true,
        check: flags.check === true,
        interactive,
        confirm: interactive ? askYesNo : undefined,
      })
      if (result.patch !== undefined && !json) process.stdout.write(result.patch)
      if (json) console.log(JSON.stringify({ ok: result.status !== 'conflicts', ...result }))
      return result.status === 'conflicts' ? EXIT.conflicts : EXIT.ok
    }
    if (namespace === 'app' && action === 'source') {
      if (flags['dry-run'] !== true) {
        throw new CliError('Usage: marcapony app source --dry-run', { exitCode: EXIT.failed })
      }
      const plan = runSourceDryRun({ cwd, log })
      if (json) console.log(JSON.stringify({ ok: true, ...plan }))
      return EXIT.ok
    }
    if (namespace === 'app' && action === 'migrate-config') {
      const result = runMigrateConfig({ cwd, log })
      if (json) console.log(JSON.stringify({ ok: true, ...result }))
      return EXIT.ok
    }
    if (namespace === 'app' && action === 'env') {
      const [, , sub, name] = command
      const base = { cwd, cliEnv, env: process.env, log }
      let result: unknown
      if (sub === 'list') {
        result = await runEnvList({ ...base, show: flags.show === true })
      } else if (sub === 'set') {
        result = await runEnvSet({
          ...base,
          name,
          secret: flags.secret === true,
          readValue: () =>
            process.stdin.isTTY ? readHidden(`Value for ${name ?? ''}: `) : readStdin(),
        })
      } else if (sub === 'delete') {
        result = await runEnvDelete({ ...base, name })
      } else {
        throw new CliError('Usage: marcapony app env list | set <NAME> | delete <NAME>', {
          exitCode: EXIT.failed,
        })
      }
      if (json) console.log(JSON.stringify({ ok: true, result }))
      return EXIT.ok
    }
    console.error(`Unknown command: ${command.join(' ')}\n`)
    console.error(USAGE)
    return EXIT.failed
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const exitCode = err instanceof CliError ? err.exitCode : EXIT.failed
    if (flags.json === true) {
      const code = err instanceof CliError ? (err.code ?? null) : null
      console.log(JSON.stringify({ ok: false, exitCode, code, message }))
    } else {
      console.error(message)
    }
    return exitCode
  }
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim())
  } finally {
    rl.close()
  }
}

// Only run as a CLI when invoked as the process entry, so importing the package
// (and the test suite) never executes a command. `process.argv[1]` is the path
// used to launch us, which is a SYMLINK when installed as a bin (npm/npx/bunx
// and `npm link` all symlink into a bin dir); resolve it so it matches the
// module's real path — a raw `file://${argv[1]}` compare misses under a symlink
// and the command would silently never run.
function isCliEntrypoint(): boolean {
  const invokedPath = process.argv[1]
  if (!invokedPath) return false
  try {
    return realpathSync(invokedPath) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isCliEntrypoint()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
