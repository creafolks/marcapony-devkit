import { describe, expect, it, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyPackageName,
  copyTemplate,
  parseArgs,
  run,
  sanitizePackageName,
  templateRoot,
  templateTargetName,
} from '../index'

// templateRoot() resolves `../template` from the compiled entry, so tests have
// to pass a URL shaped like the published one, not this test file's own.
const MODULE_URL = new URL('../../dist/index.js', import.meta.url).href

const created: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'create-marcapony-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true })
})

describe('sanitizePackageName', () => {
  it('keeps names npm already accepts', () => {
    expect(sanitizePackageName('acme-transfer')).toBe('acme-transfer')
  })

  it('lowercases and replaces characters npm rejects', () => {
    expect(sanitizePackageName('Acme Transfer!')).toBe('acme-transfer')
  })

  it('strips leading dots, underscores and dashes', () => {
    expect(sanitizePackageName('.hidden')).toBe('hidden')
    expect(sanitizePackageName('__internal')).toBe('internal')
  })

  it('falls back rather than emitting an empty name', () => {
    expect(sanitizePackageName('***')).toBe('marcapony-app')
    expect(sanitizePackageName('   ')).toBe('marcapony-app')
  })

  it('stays inside npm’s 214-character limit', () => {
    expect(sanitizePackageName('a'.repeat(300)).length).toBe(214)
  })
})

describe('templateTargetName', () => {
  it('restores the files npm cannot ship under their real names', () => {
    expect(templateTargetName('_gitignore')).toBe('.gitignore')
    expect(templateTargetName('_package.json')).toBe('package.json')
  })

  it('leaves everything else alone', () => {
    expect(templateTargetName('vite.config.ts')).toBe('vite.config.ts')
  })
})

describe('parseArgs', () => {
  it('reads the directory and flags', () => {
    expect(parseArgs(['my-app'])).toEqual({ dir: 'my-app', force: false, help: false })
    expect(parseArgs(['my-app', '--force']).force).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
  })

  it('ignores a second positional rather than misreading it as the directory', () => {
    expect(parseArgs(['first', 'second']).dir).toBe('first')
  })
})

describe('templateRoot', () => {
  // `files: ["dist", "template"]` puts the template a level above the entry in
  // the published package. If this math changes, every install breaks at runtime
  // while the build stays green.
  it('resolves the template as a sibling of dist/', () => {
    expect(templateRoot('file:///pkg/dist/index.js')).toBe('/pkg/template')
  })
})

describe('copyTemplate', () => {
  it('copies the real template and restores the underscore-prefixed files', () => {
    const target = join(tempDir(), 'app')
    copyTemplate(templateRoot(MODULE_URL), target)

    expect(existsSync(join(target, 'package.json'))).toBe(true)
    expect(existsSync(join(target, '.gitignore'))).toBe(true)
    expect(existsSync(join(target, '_package.json'))).toBe(false)
    expect(existsSync(join(target, '_gitignore'))).toBe(false)
    expect(existsSync(join(target, 'src/server/index.ts'))).toBe(true)
    expect(existsSync(join(target, 'marcapony.json'))).toBe(true)
  })

  it('ships a .gitignore that already covers the key file', () => {
    const target = join(tempDir(), 'app')
    copyTemplate(templateRoot(MODULE_URL), target)
    expect(readFileSync(join(target, '.gitignore'), 'utf8')).toContain('.dev.vars')
  })

  it('points the template at the published SDK, not a private one', () => {
    const target = join(tempDir(), 'app')
    copyTemplate(templateRoot(MODULE_URL), target)
    const manifest = readFileSync(join(target, 'package.json'), 'utf8')
    expect(manifest).toContain('"marcapony-sdk"')
    expect(manifest).not.toContain('@creafolks/')
  })

  it('declares no storage bindings — deployed apps are stateless', () => {
    const target = join(tempDir(), 'app')
    copyTemplate(templateRoot(MODULE_URL), target)
    const config = JSON.parse(readFileSync(join(target, 'marcapony.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(config.bindings).toBeUndefined()
    expect(config.worker).toBe('dist/worker/index.js')
    expect(config.assets).toBe('dist/client')
  })

  it('ships no wrangler config or dependency', () => {
    const target = join(tempDir(), 'app')
    copyTemplate(templateRoot(MODULE_URL), target)
    expect(existsSync(join(target, 'wrangler.jsonc'))).toBe(false)
    expect(existsSync(join(target, 'wrangler.json'))).toBe(false)
    expect(existsSync(join(target, 'wrangler.toml'))).toBe(false)
    expect(readFileSync(join(target, 'package.json'), 'utf8')).not.toContain('wrangler')
  })
})

describe('applyPackageName', () => {
  it('rewrites only the name', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'marcapony-app', private: true, scripts: { dev: 'x' } }),
    )
    applyPackageName(dir, 'acme-transfer')
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string
      private: boolean
      scripts: Record<string, string>
    }
    expect(manifest.name).toBe('acme-transfer')
    expect(manifest.private).toBe(true)
    expect(manifest.scripts.dev).toBe('x')
  })
})

describe('run', () => {
  it('scaffolds into a fresh directory and names the package after it', async () => {
    const cwd = tempDir()
    const previous = process.cwd()
    process.chdir(cwd)
    try {
      expect(await run(['Acme Transfer'], MODULE_URL)).toBe(0)
      const manifest = JSON.parse(
        readFileSync(join(cwd, 'Acme Transfer', 'package.json'), 'utf8'),
      ) as { name: string }
      expect(manifest.name).toBe('acme-transfer')
    } finally {
      process.chdir(previous)
    }
  })

  it('refuses a non-empty directory unless forced', async () => {
    const cwd = tempDir()
    const previous = process.cwd()
    process.chdir(cwd)
    try {
      writeFileSync(join(cwd, 'occupied.txt'), 'x')
      expect(await run(['.'], MODULE_URL)).toBe(1)
      expect(existsSync(join(cwd, 'package.json'))).toBe(false)

      expect(await run(['.', '--force'], MODULE_URL)).toBe(0)
      expect(existsSync(join(cwd, 'package.json'))).toBe(true)
      // --force writes alongside what was there; it does not clear the directory.
      expect(existsSync(join(cwd, 'occupied.txt'))).toBe(true)
    } finally {
      process.chdir(previous)
    }
  })

  // --force is how someone lands here on top of an already-linked project, and
  // .dev.vars holds a key the platform will not show a second time.
  it('never overwrites files that already exist, even with --force', async () => {
    const cwd = tempDir()
    const previous = process.cwd()
    process.chdir(cwd)
    try {
      writeFileSync(join(cwd, '.dev.vars'), 'MARCAPONY_API_KEY=mpk_alreadylinked\n')
      writeFileSync(join(cwd, 'marcapony.json'), '{"app":"already-linked"}')
      writeFileSync(join(cwd, '.gitignore'), 'node_modules\n')

      expect(await run(['.', '--force'], MODULE_URL)).toBe(0)

      expect(readFileSync(join(cwd, '.dev.vars'), 'utf8')).toContain('mpk_alreadylinked')
      expect(readFileSync(join(cwd, 'marcapony.json'), 'utf8')).toContain('already-linked')
      expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toBe('node_modules\n')
      // The underscore copy must not be left behind once its target exists.
      expect(existsSync(join(cwd, '_gitignore'))).toBe(false)
      expect(existsSync(join(cwd, '_package.json'))).toBe(false)
      // Everything that was missing still arrives.
      expect(existsSync(join(cwd, 'src/server/index.ts'))).toBe(true)
      expect(existsSync(join(cwd, 'package.json'))).toBe(true)
    } finally {
      process.chdir(previous)
    }
  })
})
