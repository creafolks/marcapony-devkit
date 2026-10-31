import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * The template pins the SDK and the CLI with a caret range. For a 0.x version a
 * caret only admits the same minor (`^0.2.0` never installs 0.6.0), so a range
 * that is not moved along with the packages quietly hands every new project an
 * old release. These tests fail as soon as the template falls behind.
 */

const TEMPLATE_MANIFEST = new URL('../../template/_package.json', import.meta.url)

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, 'utf8')) as T
}

function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) throw new Error(`Not a version: ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Whether a caret range (`^x.y.z`) admits `version`, with npm's 0.x rule. */
function caretAdmits(range: string, version: string): boolean {
  if (!range.startsWith('^')) return false
  const [rMajor, rMinor, rPatch] = parseVersion(range.slice(1))
  const [vMajor, vMinor, vPatch] = parseVersion(version)
  if (rMajor !== vMajor) return false
  if (rMajor === 0) return rMinor === vMinor && vPatch >= rPatch
  return vMinor > rMinor || (vMinor === rMinor && vPatch >= rPatch)
}

interface Manifest {
  version: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

describe('caretAdmits', () => {
  it('follows the 0.x rule', () => {
    expect(caretAdmits('^0.2.0', '0.2.5')).toBe(true)
    expect(caretAdmits('^0.2.0', '0.6.0')).toBe(false)
    expect(caretAdmits('^0.6.1', '0.6.0')).toBe(false)
  })

  it('admits later minors from 1.0 on', () => {
    expect(caretAdmits('^1.2.0', '1.9.0')).toBe(true)
    expect(caretAdmits('^1.2.0', '2.0.0')).toBe(false)
  })
})

describe('template dependency ranges', () => {
  const template = readJson<Manifest>(TEMPLATE_MANIFEST)

  it('installs the current SDK', () => {
    const sdk = readJson<Manifest>(new URL('../../../sdk/package.json', import.meta.url))
    const range = template.dependencies?.['marcapony-sdk']
    expect(range).toBeDefined()
    expect(caretAdmits(range!, sdk.version)).toBe(true)
  })

  it('pins the current CLI as a devDependency', () => {
    const cli = readJson<Manifest>(new URL('../../../cli/package.json', import.meta.url))
    const range = template.devDependencies?.marcapony
    expect(range).toBeDefined()
    expect(caretAdmits(range!, cli.version)).toBe(true)
  })
})
