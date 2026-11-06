/**
 * A small gitignore matcher, kept here instead of added as a dependency.
 *
 * Covers the syntax git documents: comments, `\#` and `\!` escapes, trailing
 * spaces (kept when escaped), `!` negation, `*`, `?`, `[...]` classes, `**` in
 * leading, middle and trailing position, a leading or middle `/` to anchor and
 * a trailing `/` for directories. Rules from a nested `.gitignore` only see
 * paths below its directory. As in git, a file cannot be re-included when one
 * of its parent directories is excluded; the caller gets that for free by not
 * walking into excluded directories.
 */

export interface IgnoreRule {
  /** True for a `!` line, which re-includes what an earlier rule excluded. */
  negate: boolean
  /** The rule as written, and where, for `marcapony app source --dry-run`. */
  pattern: string
  source: string
  test: (path: string) => boolean
}

function classToRegex(glob: string, start: number): { source: string; end: number } | null {
  let i = start + 1
  let body = ''
  if (glob[i] === '!' || glob[i] === '^') {
    body += '^'
    i++
  }
  // A `]` right after the opening bracket is a literal.
  if (glob[i] === ']') {
    body += '\\]'
    i++
  }
  for (; i < glob.length; i++) {
    const ch = glob[i] as string
    if (ch === ']') return { source: `[${body}]`, end: i }
    if (ch === '\\' && i + 1 < glob.length) {
      body += `\\${glob[++i]}`
      continue
    }
    body += ch === '/' ? '' : ch.replace(/[\\^]/g, '\\$&')
  }
  return null
}

export function globToRegexSource(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string
    if (ch === '\\' && i + 1 < glob.length) {
      out += (glob[++i] as string).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    } else if (ch === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/'
        const followedBySlash = glob[i + 2] === '/'
        i++
        if (atStart && followedBySlash) {
          // `**/` matches zero or more whole directories.
          out += '(?:.*/)?'
          i++
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '[') {
      const cls = classToRegex(glob, i)
      if (cls) {
        out += cls.source
        i = cls.end
      } else {
        out += '\\['
      }
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return out
}

/** Trailing spaces are dropped unless the last one is escaped with a backslash. */
function trimTrailingSpaces(line: string): string {
  let end = line.length
  while (end > 0 && line[end - 1] === ' ' && line[end - 2] !== '\\') end--
  return line.slice(0, end)
}

/**
 * Parses one ignore file. `base` is the directory a nested `.gitignore` sits
 * in; its rules only see paths below it.
 */
export function parseIgnoreRules(content: string, source = '', base = ''): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  const prefixPath = base ? `${base}/` : ''
  for (const raw of content.split('\n')) {
    let line = trimTrailingSpaces(raw.replace(/\r$/, '')).replace(/^\s+/, '')
    if (!line || line.startsWith('#')) continue
    const negate = line.startsWith('!')
    if (negate) line = line.slice(1)
    else if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1)
    const pattern = raw.trim()
    const dirOnly = line.endsWith('/') && !line.endsWith('\\/')
    if (dirOnly) line = line.slice(0, -1)
    const anchored = line.startsWith('/') || line.includes('/')
    line = line.replace(/^\/+/, '')
    if (!line) continue
    const body = globToRegexSource(line)
    const prefix = anchored ? '^' : '^(?:.*/)?'
    // Directories are tested as `dir/`. The pattern is matched against the path
    // without that slash, so `dir/*` matches what is inside `dir` but not `dir`
    // itself (as in git), and a later `!dir/keep` can still bring a file back.
    const re = new RegExp(`${prefix}${body}$`)
    rules.push({
      negate,
      pattern,
      source,
      test: (path) => {
        if (prefixPath && !path.startsWith(prefixPath)) return false
        const isDir = path.endsWith('/')
        if (dirOnly && !isDir) return false
        const target = path.slice(prefixPath.length)
        return re.test(isDir ? target.slice(0, -1) : target)
      },
    })
  }
  return rules
}

/** The last matching rule decides, as in git; null when the path is not ignored. */
export function decideIgnore(path: string, rules: IgnoreRule[]): IgnoreRule | null {
  let last: IgnoreRule | null = null
  for (const rule of rules) if (rule.test(path)) last = rule
  return last && !last.negate ? last : null
}
