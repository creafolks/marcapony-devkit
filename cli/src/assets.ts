import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, sep } from 'node:path'

const ASSETS_IGNORE_FILE = '.assetsignore'

/**
 * Never upload these, whatever the build emitted into the assets directory.
 * `.dev.vars` holds the app's Marcapony key — serving it would publish the
 * credential the platform just injected.
 */
const ALWAYS_IGNORED = [ASSETS_IGNORE_FILE, '.dev.vars', 'wrangler.json', 'wrangler.jsonc']

export function parseAssetsIgnore(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    // Strip a leading "./" or "/" only — a bare leading dot is part of the
    // name (".dev.vars"), not a path prefix.
    .map((line) => line.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter((line) => line.length > 0)
}

/** Exact file match or anything under a listed directory. */
export function isIgnoredAsset(servedPath: string, patterns: string[]): boolean {
  const relative = servedPath.replace(/^\//, '')
  const basename = relative.split('/').pop() ?? relative
  if (ALWAYS_IGNORED.includes(basename)) return true
  return patterns.some((p) => relative === p || relative.startsWith(`${p}/`))
}

export interface CollectedAsset {
  /** Served path, leading slash, forward slashes. */
  path: string
  /** base64 file contents. */
  content: string
  contentType: string
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

export function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return CONTENT_TYPES[filePath.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Walk an assets directory into the deployment wire format (base64 contents),
 * honouring `.assetsignore` so build output that must never be served (a
 * stray `.dev.vars`, a wrangler config) is not published.
 */
export function collectAssets(root: string): CollectedAsset[] {
  const out: CollectedAsset[] = []
  const ignorePath = join(root, ASSETS_IGNORE_FILE)
  const patterns = existsSync(ignorePath)
    ? parseAssetsIgnore(readFileSync(ignorePath, 'utf8'))
    : []

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const servedPath = posix.join(prefix, entry).split(sep).join('/')
      if (statSync(full).isDirectory()) {
        if (!isIgnoredAsset(servedPath, patterns)) walk(full, servedPath)
        continue
      }
      if (isIgnoredAsset(servedPath, patterns)) continue
      out.push({
        path: servedPath,
        content: readFileSync(full).toString('base64'),
        contentType: contentTypeFor(entry),
      })
    }
  }

  walk(root, '/')
  return out
}
