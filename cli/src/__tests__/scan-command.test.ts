import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXIT } from '../api'
import { decideIgnore, parseIgnoreRules } from '../ignore'
import { main } from '../index'
import { runScan } from '../scan'
import { planSourceFiles } from '../source'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'marcapony-scan-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(path: string, content = 'x'): void {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), content)
}

const ignored = (rules: string, path: string) =>
  decideIgnore(path, parseIgnoreRules(rules)) !== null

describe('gitignore matcher', () => {
  it('matches unanchored names at any depth and anchored ones at the root only', () => {
    expect(ignored('debug.log', 'a/b/debug.log')).toBe(true)
    expect(ignored('/debug.log', 'a/debug.log')).toBe(false)
    expect(ignored('/debug.log', 'debug.log')).toBe(true)
    expect(ignored('docs/*.md', 'docs/a.md')).toBe(true)
    expect(ignored('docs/*.md', 'x/docs/a.md')).toBe(false)
  })

  it('directory patterns match directories only', () => {
    expect(ignored('build/', 'build/')).toBe(true)
    expect(ignored('build/', 'build')).toBe(false)
  })

  it('handles ** in leading, middle and trailing position', () => {
    expect(ignored('**/cache', 'a/b/cache')).toBe(true)
    expect(ignored('a/**/b', 'a/b')).toBe(true)
    expect(ignored('a/**/b', 'a/x/y/b')).toBe(true)
    expect(ignored('a/**/b', 'a/xb')).toBe(false)
    expect(ignored('logs/**', 'logs/2026/x.log')).toBe(true)
  })

  it('handles classes, ? and escapes', () => {
    expect(ignored('file[0-9].txt', 'file7.txt')).toBe(true)
    expect(ignored('file[!0-9].txt', 'file7.txt')).toBe(false)
    expect(ignored('file?.txt', 'fileA.txt')).toBe(true)
    expect(ignored('\\#notes', '#notes')).toBe(true)
    expect(ignored('\\!important', '!important')).toBe(true)
    expect(ignored('trailing\\ ', 'trailing ')).toBe(true)
    expect(ignored('spaces   ', 'spaces')).toBe(true)
  })

  it('the last matching rule wins, so ! re-includes', () => {
    expect(ignored('*.log\n!keep.log', 'keep.log')).toBe(false)
    expect(ignored('*.log\n!keep.log\nkeep.log', 'keep.log')).toBe(true)
  })

  it('a file under an excluded directory cannot be re-included, as in git', () => {
    write('.gitignore', 'vendor/\n!vendor/keep.js\n')
    write('vendor/keep.js')
    write('src/app.ts')
    expect(planSourceFiles(dir, { app: 'a', build: '' }).files).toEqual([
      '.gitignore',
      'src/app.ts',
    ])
  })

  it('a negation never brings back node_modules or a credential file', () => {
    write('.gitignore', '!node_modules/\n!.env\n')
    write('node_modules/x/index.js')
    write('.env', 'X=1')
    write('src/app.ts')
    expect(planSourceFiles(dir, { app: 'a', build: '' }).files).toEqual([
      '.gitignore',
      'src/app.ts',
    ])
  })
})

describe('marcapony scan', () => {
  const secret = ['const k = "mpk', '_', 'A1b2C3d4E5f6G7h8I9"'].join('')

  it('reports findings with masked values and exits 6', async () => {
    write('src/leak.ts', secret)
    write('src/ok.ts', 'export const a = 1')
    const logs: string[] = []
    const result = runScan({ cwd: dir, log: (m) => logs.push(m) })
    expect(result.findings.map((f) => `${f.path}:${f.line}`)).toEqual(['src/leak.ts:1'])
    expect(logs.join('\n')).toContain('src/leak.ts:1  Marcapony API key  mpk_…')
    expect(logs.join('\n')).not.toContain('A1b2C3d4')

    const originalLog = console.log
    console.log = () => {}
    try {
      expect(await main(['scan', '--cwd', dir])).toBe(EXIT.secretsFound)
    } finally {
      console.log = originalLog
    }
  })

  it('exits 0 when clean and skips ignored files', async () => {
    write('.gitignore', 'local/\n')
    write('local/leak.ts', secret)
    write('src/ok.ts', 'export const a = 1')
    const originalLog = console.log
    const out: string[] = []
    console.log = (m: string) => out.push(m)
    try {
      expect(await main(['scan', '--cwd', dir, '--json'])).toBe(EXIT.ok)
    } finally {
      console.log = originalLog
    }
    const json = JSON.parse(out.at(-1) ?? '{}')
    expect(json).toMatchObject({ ok: true, files: 2, findings: [] })
  })

  it('lists allowed matches without failing', () => {
    write('src/fixture.ts', `${secret} // marcapony-scan: allow`)
    const result = runScan({ cwd: dir, log: () => {} })
    expect(result.findings).toEqual([])
    expect(result.allowed).toHaveLength(1)
  })
})
