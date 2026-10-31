/**
 * `bun run check:templates` — scaffolds every template into a temporary
 * directory and proves it compiles: `tsc --noEmit` over the whole project and
 * the worker bundle from its own `build:worker` script. The SDK is resolved
 * from this repository's `sdk/` build, so a template cannot drift from the SDK
 * it ships with. Too slow for the unit suite (it installs the template's
 * dependencies once), so CI runs it as its own step.
 *
 * Pass --keep to leave the scaffolded projects behind for inspection.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { scaffoldTemplate, TEMPLATES } from '../src/index'

const HERE = resolve(import.meta.dir, '..')
const TEMPLATE_ROOT = join(HERE, 'template')
const SDK_DIR = resolve(HERE, '..', 'sdk')
const keep = process.argv.includes('--keep')

function sh(cmd: string[], cwd: string): boolean {
  const result = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' })
  return result.exitCode === 0
}

if (!existsSync(join(SDK_DIR, 'dist', 'index.d.ts'))) {
  console.info('Building the SDK first (sdk/dist is missing)')
  if (!sh(['bun', 'install', '--frozen-lockfile'], SDK_DIR) || !sh(['bun', 'run', 'build'], SDK_DIR)) {
    console.error('Could not build the SDK.')
    process.exit(1)
  }
}

interface Manifest {
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}
const manifest = JSON.parse(readFileSync(join(TEMPLATE_ROOT, 'base', '_package.json'), 'utf8')) as Manifest

// One shared install for all templates: they share the base's dependencies,
// and Node resolution walks up from each project into this node_modules. The
// SDK is linked from the local build; the CLI is not needed to compile.
const work = mkdtempSync(join(tmpdir(), 'marcapony-templates-'))
const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
delete dependencies['marcapony-sdk']
delete dependencies.marcapony
writeFileSync(
  join(work, 'package.json'),
  JSON.stringify({ name: 'template-check', private: true, dependencies }, null, 2),
)

let failed = 0
try {
  if (!sh(['bun', 'install', '--silent'], work)) {
    console.error('Installing the template dependencies failed.')
    process.exit(1)
  }
  mkdirSync(join(work, 'node_modules'), { recursive: true })
  symlinkSync(SDK_DIR, join(work, 'node_modules', 'marcapony-sdk'), 'dir')

  const bin = (name: string) => join(work, 'node_modules', '.bin', name)
  const workerArgs = manifest.scripts['build:worker']!.split(' ').slice(1)

  for (const { name } of TEMPLATES) {
    const dir = join(work, name)
    scaffoldTemplate(TEMPLATE_ROOT, name, dir)
    const typechecks = sh([bin('tsc'), '--noEmit', '-p', 'tsconfig.json'], dir)
    const bundles = typechecks && sh([bin('esbuild'), ...workerArgs, '--log-level=warning'], dir)
    console.info(`${typechecks && bundles ? 'ok  ' : 'FAIL'} ${name}`)
    if (!(typechecks && bundles)) failed++
  }
} finally {
  if (keep) console.info(`Kept ${work}`)
  else rmSync(work, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`${failed} template(s) failed.`)
  process.exit(1)
}
console.info(`All ${TEMPLATES.length} templates typecheck and bundle.`)
