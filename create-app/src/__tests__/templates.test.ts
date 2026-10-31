import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  copyTemplate,
  HELP,
  nextSteps,
  run,
  scaffoldTemplate,
  TEMPLATES,
  templateRoot,
  type TemplateName,
} from '../index'

const MODULE_URL = new URL('../../dist/index.js', import.meta.url).href
const ROOT = templateRoot(MODULE_URL)
const NAMES = TEMPLATES.map((t) => t.name)

const created: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'create-marcapony-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true })
})

async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd()
  process.chdir(dir)
  try {
    return await fn()
  } finally {
    process.chdir(previous)
  }
}

function captureStderr(): { text: () => string; restore: () => void } {
  const original = process.stderr.write.bind(process.stderr)
  let buffer = ''
  process.stderr.write = ((chunk: string | Uint8Array) => {
    buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    return true
  }) as typeof process.stderr.write
  return { text: () => buffer, restore: () => void (process.stderr.write = original) }
}

/** Every field `MarcaponyConfig` declares, read from the CLI's own source. */
function cliConfigKeys(): Set<string> {
  const source = readFileSync(new URL('../../../cli/src/config.ts', import.meta.url), 'utf8')
  const body = /export interface MarcaponyConfig \{([\s\S]*?)\n\}/.exec(source)?.[1]
  if (!body) throw new Error('MarcaponyConfig not found in cli/src/config.ts')
  return new Set([...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!))
}

interface TemplateConfig {
  placement?: string
  dataAccess?: string
  permissions?: Array<{ id: string; label: string; grants?: string[] }>
  [key: string]: unknown
}

describe('the template set', () => {
  it('has a directory for every template and for the shared base', () => {
    const dirs = readdirSync(ROOT).sort()
    expect(dirs).toEqual(['base', ...NAMES].sort())
  })

  it('lists every template in the help', () => {
    for (const name of NAMES) expect(HELP).toContain(name)
    expect(HELP).toContain('--template')
  })

  it('points at the template README in the next steps', () => {
    expect(nextSteps('my-app', 'shop')).toContain('shop template')
    expect(nextSteps('my-app', 'shop')).toContain('README.md')
  })
})

describe.each(NAMES as TemplateName[])('the %s template', (name) => {
  function scaffold(): string {
    const target = join(tempDir(), 'app')
    scaffoldTemplate(ROOT, name, target)
    return target
  }

  it('scaffolds the base and its own files', () => {
    const target = scaffold()
    for (const file of [
      'package.json',
      '.gitignore',
      '.dev.vars.example',
      'index.html',
      'tsconfig.json',
      'vite.config.ts',
      'marcapony.json',
      'README.md',
      'scripts/dev.ts',
      'src/server/index.ts',
      'src/server/marcapony.ts',
      'src/ui/App.tsx',
      'src/ui/api.ts',
      'src/ui/main.tsx',
      'src/ui/styles.css',
    ]) {
      expect(existsSync(join(target, file))).toBe(true)
    }
    expect(existsSync(join(target, '_package.json'))).toBe(false)
    expect(existsSync(join(target, '_gitignore'))).toBe(false)
  })

  it('takes its overlay files over the base', () => {
    const target = scaffold()
    for (const file of ['README.md', 'src/server/index.ts', 'src/ui/App.tsx']) {
      expect(readFileSync(join(target, file), 'utf8')).toBe(
        readFileSync(join(ROOT, name, file), 'utf8'),
      )
    }
    const overlayConfig = join(ROOT, name, 'marcapony.json')
    const expected = existsSync(overlayConfig) ? overlayConfig : join(ROOT, 'base', 'marcapony.json')
    expect(readFileSync(join(target, 'marcapony.json'), 'utf8')).toBe(
      readFileSync(expected, 'utf8'),
    )
  })

  it('has a marcapony.json that only uses keys the CLI knows', () => {
    const config = JSON.parse(readFileSync(join(scaffold(), 'marcapony.json'), 'utf8')) as TemplateConfig
    const known = cliConfigKeys()
    for (const key of Object.keys(config)) expect(known.has(key)).toBe(true)
    // `app` is written by `bun run link`; a template must not invent one.
    expect(config.app).toBeUndefined()
    expect(config.bindings).toBeUndefined()
    if (config.placement !== undefined) expect(['portal', 'public']).toContain(config.placement)
    if (config.dataAccess !== undefined) {
      expect(['account', 'visitor', 'customer', 'team']).toContain(config.dataAccess)
    }
  })

  it('only grants platform permissions the CLI documents', () => {
    const config = JSON.parse(readFileSync(join(scaffold(), 'marcapony.json'), 'utf8')) as TemplateConfig
    const cliSource = readFileSync(new URL('../../../cli/src/config.ts', import.meta.url), 'utf8')
    for (const permission of config.permissions ?? []) {
      expect(permission.id).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(permission.label.length).toBeGreaterThan(0)
      for (const grant of permission.grants ?? []) expect(cliSource).toContain(`\`${grant}\``)
    }
  })

  it('documents the setup an agent has to ask the owner for', () => {
    const readme = readFileSync(join(scaffold(), 'README.md'), 'utf8')
    for (const heading of ['## Set up in the dashboard', '## Routes', '## What to change first']) {
      expect(readme).toContain(heading)
    }
    expect(readme).toContain('Scopes')
    expect(readme).not.toMatch(/(npx|bunx) marcapony/)
    const config = JSON.parse(readFileSync(join(scaffold(), 'marcapony.json'), 'utf8')) as TemplateConfig
    for (const permission of config.permissions ?? []) expect(readme).toContain(permission.id)
  })

  it('scaffolds through run with --template and names the package', async () => {
    const cwd = tempDir()
    expect(await inDir(cwd, () => run(['My Shop', '--template', name], MODULE_URL))).toBe(0)
    const manifest = JSON.parse(readFileSync(join(cwd, 'My Shop', 'package.json'), 'utf8')) as {
      name: string
    }
    expect(manifest.name).toBe('my-shop')
    expect(readFileSync(join(cwd, 'My Shop', 'src/ui/App.tsx'), 'utf8')).toBe(
      readFileSync(join(ROOT, name, 'src/ui/App.tsx'), 'utf8'),
    )
  })
})

describe('the portal templates', () => {
  it('declare their placement and data access', () => {
    const read = (name: string) =>
      JSON.parse(readFileSync(join(ROOT, name, 'marcapony.json'), 'utf8')) as TemplateConfig
    expect(read('booking')).toMatchObject({ placement: 'portal', dataAccess: 'customer' })
    expect(read('team-tool')).toMatchObject({ placement: 'portal', dataAccess: 'team' })
    expect(read('shop').placement).toBe('public')
  })
})

describe('run with a template', () => {
  it('uses blank when stdin is not a terminal and no template is given', async () => {
    const cwd = tempDir()
    expect(await inDir(cwd, () => run(['app'], MODULE_URL))).toBe(0)
    expect(readFileSync(join(cwd, 'app', 'src/ui/App.tsx'), 'utf8')).toBe(
      readFileSync(join(ROOT, 'blank', 'src/ui/App.tsx'), 'utf8'),
    )
  })

  it('refuses an unknown template and lists the valid ones', async () => {
    const cwd = tempDir()
    const stderr = captureStderr()
    try {
      expect(await inDir(cwd, () => run(['app', '--template', 'blog'], MODULE_URL))).toBe(1)
    } finally {
      stderr.restore()
    }
    expect(stderr.text()).toContain('Unknown template "blog"')
    for (const name of NAMES) expect(stderr.text()).toContain(name)
    expect(existsSync(join(cwd, 'app'))).toBe(false)
  })

  it('refuses --template without a value', async () => {
    const cwd = tempDir()
    const stderr = captureStderr()
    try {
      expect(await inDir(cwd, () => run(['app', '--template'], MODULE_URL))).toBe(1)
    } finally {
      stderr.restore()
    }
    expect(existsSync(join(cwd, 'app'))).toBe(false)
  })

  // --force lands on top of an already-linked project: neither the overlay nor
  // the base may replace the key or the linked config.
  it('never overwrites .dev.vars or marcapony.json with --force, for any template', async () => {
    for (const name of NAMES) {
      const cwd = tempDir()
      writeFileSync(join(cwd, '.dev.vars'), 'MARCAPONY_API_KEY=mpk_alreadylinked\n')
      writeFileSync(join(cwd, 'marcapony.json'), '{"app":"already-linked"}')
      expect(await inDir(cwd, () => run(['.', '--force', '--template', name], MODULE_URL))).toBe(0)
      expect(readFileSync(join(cwd, '.dev.vars'), 'utf8')).toContain('mpk_alreadylinked')
      expect(readFileSync(join(cwd, 'marcapony.json'), 'utf8')).toBe('{"app":"already-linked"}')
      expect(existsSync(join(cwd, 'src/server/index.ts'))).toBe(true)
    }
  })

  it('fills in missing files under a directory that already exists', () => {
    const target = tempDir()
    mkdirSync(join(target, 'src/server'), { recursive: true })
    writeFileSync(join(target, 'src/server/index.ts'), '// mine\n')
    copyTemplate(join(ROOT, 'base'), target)
    expect(readFileSync(join(target, 'src/server/index.ts'), 'utf8')).toBe('// mine\n')
    expect(existsSync(join(target, 'src/server/marcapony.ts'))).toBe(true)
    expect(existsSync(join(target, 'src/ui/main.tsx'))).toBe(true)
  })
})

// `Product.status` is 1 draft, 2 published, 3 archived. A visitor must never
// see, or be able to buy, a product the business has not published.
describe('templates that show products', () => {
  const server = (name: string) => readFileSync(join(ROOT, name, 'src/server/index.ts'), 'utf8')

  it('only show published products', () => {
    for (const name of ['blank', 'shop']) {
      expect(server(name)).toContain('const PUBLISHED = 2')
      expect(server(name)).toMatch(/status [!=]== PUBLISHED/)
    }
  })

  it('refuse to check out a product that is not published', () => {
    const shop = server('shop')
    const checkout = shop.slice(shop.indexOf("app.post('/api/checkout'"))
    expect(checkout).toContain('product.status !== PUBLISHED')
  })
})
