#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runDeploy } from './deploy.js'
import { runLink } from './link.js'
import { runGuide } from './guide.js'

export { runLink } from './link.js'
export { runDeploy } from './deploy.js'
export { runGuide } from './guide.js'
export * from './config.js'
export * from './api.js'
export * from './assets.js'
export * from './agents.js'

// Kept in step with cli/package.json by a test — `marcapony --version` is the
// first thing a bug report quotes, so it must not drift from what was shipped.
const VERSION = '0.3.3'

const USAGE = `marcapony — build and deploy Marcapony apps

Usage
  marcapony app link [--code <code>] [--cwd <dir>]
  marcapony app deploy [--cwd <dir>] [--message <text>]
  marcapony guide [--cwd <dir>]

Commands
  app link     Exchange a one-time pairing code for this project's environment
               key. Writes .dev.vars, marcapony.json and AGENTS.md. Get the code
               from the app's page in your Marcapony dashboard.
  app deploy   Run the project's build, upload the bundle, and wait until it is
               live. The target environment comes from the key — there is no
               --env flag.
  guide        Print the AI-readable setup guide for this project (the same
               content written to AGENTS.md), listing the SDK calls and schemas
               your app key can use.

Options
  --code <code>     Pairing code (link only; prompted when omitted)
  --cwd <dir>       Project directory (defaults to the current directory)
  -h, --help        Show this help
  -v, --version     Show the CLI version
`

export interface ParsedArgs {
  command: string[]
  flags: Record<string, string | boolean>
}

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
    if (next !== undefined && !next.startsWith('-')) {
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
      await runLink({ cwd, cliEnv, code: stringFlag(flags, 'code'), env: process.env })
      return 0
    }
    if (namespace === 'app' && action === 'deploy') {
      await runDeploy({ cwd, cliEnv, env: process.env, message: stringFlag(flags, 'message') })
      return 0
    }
    console.error(`Unknown command: ${command.join(' ')}\n`)
    console.error(USAGE)
    return 1
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
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
