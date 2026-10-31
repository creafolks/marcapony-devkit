#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'

/**
 * `create-marcapony-app` — copies the template in `template/` into a new
 * directory and points its package.json at the chosen name. Deliberately does
 * no key handling and no deploy: `marcapony app link` mints the key and
 * `marcapony app deploy` ships the project, and both work on any project, not
 * just a scaffolded one.
 */

const DEFAULT_DIR = 'marcapony-app'

/**
 * npm refuses to load a package whose name breaks its rules, and the name here
 * comes from a directory the user typed. Keep the recognizable part, drop the
 * rest, and fall back rather than emit something npm will reject.
 */
export function sanitizePackageName(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/-+$/, '')
    .slice(0, 214)
  return cleaned.length > 0 ? cleaned : DEFAULT_DIR
}

/**
 * npm strips `.gitignore` out of published tarballs and a nested `package.json`
 * confuses tooling that walks the tree, so both ship under an underscore and are
 * restored on copy — the same convention `create-vite` uses.
 */
const TEMPLATE_RENAMES: Record<string, string> = {
  _gitignore: '.gitignore',
  _package_json: 'package.json',
  '_package.json': 'package.json',
}

export function templateTargetName(name: string): string {
  return TEMPLATE_RENAMES[name] ?? name
}

export interface ParsedArgs {
  dir?: string
  force: boolean
  help: boolean
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { force: false, help: false }
  for (const arg of argv) {
    if (arg === '--force') out.force = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (!arg.startsWith('-') && out.dir === undefined) out.dir = arg
  }
  return out
}

export const HELP = `create-marcapony-app — scaffold a Marcapony app

Usage
  npx create-marcapony-app [directory] [--force]

Options
  --force   Write into the directory even if it already has files
  -h        Show this help

Next, in the new directory:
  npx marcapony app link     get this app's key
  bun run dev                 run it locally
  npx marcapony app deploy   put it live
`

export function nextSteps(dir: string): string {
  return [
    '',
    `Created ${dir}.`,
    '',
    'Next:',
    `  cd ${dir}`,
    '  bun install',
    '  npx marcapony app link     # writes your app key into .dev.vars',
    '  bun run dev',
    '',
    'When it is ready:',
    '  npx marcapony app deploy',
    '',
  ].join('\n')
}

/** Resolve `template/` relative to the compiled entry, not the cwd. */
export function templateRoot(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', 'template')
}

/**
 * Copy the template, never overwriting a file that is already there.
 *
 * That matters most with `--force`, which is how someone lands here with a
 * directory that already has content. Clobbering would destroy exactly the files
 * you cannot get back: `.dev.vars` holds a key the platform will not show again,
 * and `marcapony.json` holds the app slug `marcapony app link` wrote. Filling in
 * only what is missing is both safer and the more useful meaning of --force.
 */
export function copyTemplate(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  cpSync(from, to, {
    recursive: true,
    force: false,
    errorOnExist: false,
    // Skip a template file when its destination — under the name it will
    // actually land as — already exists.
    filter: (source) => {
      const relative = source.slice(from.length).replace(/^[/\\]/, '')
      if (relative.length === 0) return true
      const segments = relative.split(/[/\\]/)
      const last = segments[segments.length - 1]
      if (last === undefined) return true
      segments[segments.length - 1] = templateTargetName(last)
      return !existsSync(join(to, ...segments))
    },
  })
  for (const [source, target] of Object.entries(TEMPLATE_RENAMES)) {
    const sourcePath = join(to, source)
    if (!existsSync(sourcePath)) continue
    const targetPath = join(to, target)
    if (existsSync(targetPath)) {
      // The real name was already present, so the underscore copy is redundant.
      rmSync(sourcePath)
      continue
    }
    renameSync(sourcePath, targetPath)
  }
}

export function applyPackageName(dir: string, name: string): void {
  const path = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  manifest.name = name
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

function isNonEmptyDir(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).length > 0
}

async function promptForDir(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`Directory name (${DEFAULT_DIR}): `)
    return answer.trim().length > 0 ? answer.trim() : DEFAULT_DIR
  } finally {
    rl.close()
  }
}

export async function run(argv: string[], moduleUrl: string): Promise<number> {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(HELP)
    return 0
  }

  const requested = args.dir ?? (process.stdin.isTTY ? await promptForDir() : DEFAULT_DIR)
  const target = resolve(process.cwd(), requested)

  if (isNonEmptyDir(target) && !args.force) {
    process.stderr.write(
      `${requested} already has files in it. Pick another name, or pass --force to write into it anyway.\n`,
    )
    return 1
  }

  const template = templateRoot(moduleUrl)
  if (!existsSync(template)) {
    process.stderr.write(
      `The template directory is missing from this install (looked in ${template}). Reinstall create-marcapony-app.\n`,
    )
    return 1
  }

  copyTemplate(template, target)
  applyPackageName(target, sanitizePackageName(basename(target)))
  process.stdout.write(nextSteps(requested))
  return 0
}

/**
 * npm installs the bin as a symlink, so comparing argv[1] to import.meta.url
 * directly never matches — resolve the link first. Same guard as the CLI's.
 */
function isEntrypoint(): boolean {
  const invokedPath = process.argv[1]
  if (!invokedPath) return false
  try {
    return realpathSync(invokedPath) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  process.exitCode = await run(process.argv.slice(2), import.meta.url)
}
