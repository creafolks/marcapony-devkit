import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Who is calling: the CLI's version, sent with every request so the platform
 * can tell an outdated CLI or SDK to update, and store what built a version.
 */

// Kept in step with cli/package.json by a test: `marcapony --version` is the
// first thing a bug report quotes, so it must not drift from what was shipped.
export const CLI_VERSION = '0.12.0'

export const CLI_VERSION_HEADER = 'X-Marcapony-Cli'
export const SDK_VERSION_HEADER = 'X-Marcapony-Sdk'

function runtimeLabel(): string {
  const bun = (process.versions as Record<string, string | undefined>).bun
  return bun ? `bun/${bun}` : `node/${process.versions.node}`
}

/** `marcapony-cli/0.12.0 (bun/1.4.4; darwin)` */
export function userAgent(): string {
  return `marcapony-cli/${CLI_VERSION} (${runtimeLabel()}; ${process.platform})`
}

/**
 * A fetch that adds the CLI's User-Agent and version header. Headers the
 * caller set win, so a request can still name its own User-Agent.
 */
export function withCliHeaders(fetchImpl: typeof fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (!headers.has('User-Agent')) headers.set('User-Agent', userAgent())
    if (!headers.has(CLI_VERSION_HEADER)) headers.set(CLI_VERSION_HEADER, CLI_VERSION)
    return fetchImpl(input, { ...init, headers })
  }) as typeof fetch
}

/**
 * The default fetch of every platform call. It resolves the global fetch on
 * each call, so a test that replaces `globalThis.fetch` is still honoured.
 */
export const cliFetch: typeof fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  withCliHeaders(globalThis.fetch)(input, init)) as typeof fetch

const SDK_PACKAGE = 'marcapony-sdk'

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * The SDK version a project builds with: the installed package first, else
 * the range in the project's package.json. Null when the app does not use the
 * SDK. Only a plain version or range is returned, never other text.
 */
export function projectSdkVersion(cwd: string): string | null {
  const installed = join(cwd, 'node_modules', SDK_PACKAGE, 'package.json')
  if (existsSync(installed)) {
    const version = readJson(installed)?.version
    if (typeof version === 'string' && isVersionText(version)) return version
  }
  const pkg = readJson(join(cwd, 'package.json'))
  if (!pkg) return null
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[field]
    if (!deps || typeof deps !== 'object') continue
    const range = (deps as Record<string, unknown>)[SDK_PACKAGE]
    if (typeof range === 'string' && isVersionText(range)) return range
  }
  return null
}

/** A version or a simple range (`0.7.1`, `^0.7.1`, `~0.7`), short enough for a header. */
function isVersionText(value: string): boolean {
  return (
    value.length <= 64 && /^[\^~>=<v\s]*\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/.test(value.trim())
  )
}
