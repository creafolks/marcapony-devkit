/**
 * Rendering for character answers. A character writes a small Markdown subset:
 * paragraphs, bold, emphasis, strikethrough, inline code, links, and bullet or
 * numbered lists. `renderPersonaMarkdown` turns exactly that subset into safe
 * HTML and leaves everything else (headings, images, tables, quotes, raw HTML)
 * as escaped text; `personaMarkdownToText` strips it to plain text.
 *
 * No dependencies, no DOM: it runs in a browser, a worker or a server.
 */

type Tag = 'strong' | 'em' | 'del'

type Inline =
  | { kind: 'text'; value: string }
  | { kind: 'br' }
  | { kind: 'code'; value: string }
  | { kind: 'open'; tag: Tag }
  | { kind: 'close'; tag: Tag }
  | { kind: 'link'; href: string | null; url: string; label: Inline[] }

interface Delim {
  kind: 'delim'
  char: '*' | '_' | '~'
  /** Characters of the run still unused. */
  count: number
  /** Length of the run as written. */
  length: number
  canOpen: boolean
  canClose: boolean
  /** Closing tags, emitted before the remaining characters. */
  before: Inline[]
  /** Opening tags, emitted after the remaining characters. */
  after: Inline[]
}

type Token = Inline | Delim

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul' | 'ol'; start: number; items: string[][]; blank: boolean }

const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])
const MAX_LABEL = 1000
const MAX_DESTINATION = 4096

const BULLET = /^ {0,3}[-*][ \t]+(\S.*)$/
const ORDERED = /^ {0,3}(\d{1,9})\.[ \t]+(\S.*)$/
const ASCII_PUNCT = /[!-/:-@[-`{-~]/
const AUTOLINK_START = /^https?:\/\/[^\s<>]/i
const AUTOLINK_BOUNDARY = /[\s*_~(<"']/

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isWhitespace(c: string): boolean {
  return c === '' || /\s/u.test(c)
}

function isPunctuation(c: string): boolean {
  return c !== '' && /[\p{P}\p{S}]/u.test(c)
}

/** The whole character before `i`, joining a surrogate pair; '' at the start. */
function charBefore(src: string, i: number): string {
  if (i <= 0) return ''
  const low = src.charCodeAt(i - 1)
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = src.charCodeAt(i - 2)
    if (high >= 0xd800 && high <= 0xdbff) return src.slice(i - 2, i)
  }
  return src.charAt(i - 1)
}

/** The whole character at `i`, joining a surrogate pair; '' past the end. */
function charAt(src: string, i: number): string {
  const code = src.codePointAt(i)
  return code === undefined ? '' : String.fromCodePoint(code)
}

function runLength(src: string, i: number, c: string): number {
  let j = i
  while (src.charAt(j) === c) j++
  return j - i
}

/**
 * Returns a link target the browser may follow, or null. Only http, https,
 * mailto and tel, plus relative and fragment URLs, pass. The scheme is read
 * the way a browser reads it, with whitespace and control characters removed
 * and case ignored, so `JaVaScRiPt:` and `java\tscript:` are refused too.
 */
function safeHref(url: string): string | null {
  const cleaned = stripControlCharacters(url).trim()
  if (cleaned === '') return null
  const probe = cleaned.replace(/\s+/gu, '').toLowerCase()
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(probe)
  if (scheme && !ALLOWED_SCHEMES.has(scheme[1]!)) return null
  return cleaned.replace(/\s/gu, (c) => encodeURIComponent(c))
}

/** Removes C0 and C1 control characters, which browsers drop or ignore in URLs. */
function stripControlCharacters(value: string): string {
  let out = ''
  for (const c of value) {
    const code = c.charCodeAt(0)
    if (code > 0x1f && (code < 0x7f || code > 0x9f)) out += c
  }
  return out
}

class InlineParser {
  /** Backtick run lengths with no closing run after the last search. */
  private readonly noCloser = new Set<number>()
  /** Closers already found, by search start and run length, so nested `[` scans reuse them. */
  private readonly closers = new Map<string, number>()

  constructor(
    private readonly src: string,
    private readonly inLabel: boolean,
  ) {}

  /** Index of the closing backtick run of exactly `length`, or -1. */
  private backtickClose(from: number, length: number): number {
    if (this.noCloser.has(length)) return -1
    const key = `${from}:${length}`
    const cached = this.closers.get(key)
    if (cached !== undefined) return cached
    const { src } = this
    let j = from
    while (j < src.length) {
      if (src.charAt(j) !== '`') {
        j++
        continue
      }
      const run = runLength(src, j, '`')
      if (run === length) {
        this.closers.set(key, j)
        return j
      }
      j += run
    }
    this.noCloser.add(length)
    return -1
  }

  /** Parses `[label](destination)` at `i`, or returns null. */
  private link(i: number): { node: Inline; end: number } | null {
    const { src } = this
    let j = i + 1
    let depth = 0
    for (; j < src.length && j - i <= MAX_LABEL; j++) {
      const c = src.charAt(j)
      if (c === '\\') {
        j++
      } else if (c === '`') {
        const run = runLength(src, j, '`')
        const close = this.backtickClose(j + run, run)
        j = (close === -1 ? j + run : close + run) - 1
      } else if (c === '[') {
        depth++
      } else if (c === ']') {
        if (depth === 0) break
        depth--
      }
    }
    if (src.charAt(j) !== ']' || src.charAt(j + 1) !== '(') return null
    const labelEnd = j
    let k = j + 2
    let parens = 0
    for (; k < src.length && k - labelEnd <= MAX_DESTINATION; k++) {
      const c = src.charAt(k)
      if (c === '\\') k++
      else if (c === '\n') return null
      else if (c === '(') parens++
      else if (c === ')') {
        if (parens === 0) break
        parens--
      }
    }
    if (src.charAt(k) !== ')') return null

    let destination = src.slice(labelEnd + 2, k).trim()
    const titled = /^(\S+)\s+("[^"]*"|'[^']*')$/su.exec(destination)
    if (titled) destination = titled[1]!
    if (destination.startsWith('<') && destination.endsWith('>')) {
      destination = destination.slice(1, -1)
    }
    destination = destination.replace(/\\([!-/:-@[-`{-~])/g, '$1')

    let label = new InlineParser(src.slice(i + 1, labelEnd), true).parse()
    if (label.length === 0) label = [{ kind: 'text', value: destination }]
    return {
      node: { kind: 'link', href: safeHref(destination), url: destination, label },
      end: k + 1,
    }
  }

  /** End of a bare URL starting at `i` (GFM-style), or `i` when there is none. */
  private autolinkEnd(i: number): number {
    const { src } = this
    if (!AUTOLINK_START.test(src.slice(i, i + 9))) return i
    let end = i
    while (end < src.length && !/[\s<>]/u.test(src.charAt(end))) end++
    for (;;) {
      const url = src.slice(i, end)
      const last = url.charAt(url.length - 1)
      if (/[?!.,:;*_~'"]/.test(last)) {
        end--
      } else if (last === ')' && count(url, '(') < count(url, ')')) {
        end--
      } else if (last === ']' && count(url, '[') < count(url, ']')) {
        end--
      } else {
        break
      }
    }
    const url = src.slice(i, end)
    return /^https?:\/\/[^/?#]/i.test(url) ? end : i
  }

  parse(): Inline[] {
    const { src } = this
    const tokens: Token[] = []
    let text = ''
    const flush = () => {
      if (text !== '') tokens.push({ kind: 'text', value: text })
      text = ''
    }

    let i = 0
    while (i < src.length) {
      const c = src.charAt(i)

      if (c === '\\' && ASCII_PUNCT.test(src.charAt(i + 1))) {
        text += src.charAt(i + 1)
        i += 2
        continue
      }
      if (c === '\n') {
        flush()
        tokens.push({ kind: 'br' })
        i++
        continue
      }
      if (c === '`') {
        const run = runLength(src, i, '`')
        const close = this.backtickClose(i + run, run)
        if (close === -1) {
          text += src.slice(i, i + run)
        } else {
          flush()
          tokens.push({ kind: 'code', value: codeContent(src.slice(i + run, close)) })
          i = close
        }
        i += run
        continue
      }
      if (c === '!' && src.charAt(i + 1) === '[') {
        // Images are not part of the subset: keep the whole thing as text.
        const image = this.inLabel ? null : this.link(i + 1)
        const end = image ? image.end : i + 2
        text += src.slice(i, end)
        i = end
        continue
      }
      if (c === '[' && !this.inLabel) {
        const link = this.link(i)
        if (link) {
          flush()
          tokens.push(link.node)
          i = link.end
          continue
        }
      }
      if ((c === 'h' || c === 'H') && !this.inLabel) {
        const prev = charBefore(src, i)
        if (prev === '' || AUTOLINK_BOUNDARY.test(prev)) {
          const end = this.autolinkEnd(i)
          if (end > i) {
            flush()
            const url = src.slice(i, end)
            tokens.push({ kind: 'link', href: url, url, label: [{ kind: 'text', value: url }] })
            i = end
            continue
          }
        }
      }
      if (c === '*' || c === '_' || c === '~') {
        const run = runLength(src, i, c)
        if (c === '~' && run !== 2) {
          text += src.slice(i, i + run)
          i += run
          continue
        }
        const prev = charBefore(src, i)
        const next = charAt(src, i + run)
        const left =
          !isWhitespace(next) && (!isPunctuation(next) || isWhitespace(prev) || isPunctuation(prev))
        const right =
          !isWhitespace(prev) && (!isPunctuation(prev) || isWhitespace(next) || isPunctuation(next))
        const intraword = c === '_'
        flush()
        tokens.push({
          kind: 'delim',
          char: c,
          count: run,
          length: run,
          canOpen: intraword ? left && (!right || isPunctuation(prev)) : left,
          canClose: intraword ? right && (!left || isPunctuation(next)) : right,
          before: [],
          after: [],
        })
        i += run
        continue
      }

      text += c
      i++
    }
    flush()
    matchEmphasis(tokens)
    return flatten(tokens)
  }
}

function count(value: string, c: string): number {
  return value.split(c).length - 1
}

/** CommonMark code span content: line endings become spaces, one padding space is dropped. */
function codeContent(raw: string): string {
  const value = raw.replace(/\n/g, ' ')
  if (value.length >= 2 && value.startsWith(' ') && value.endsWith(' ') && value.trim() !== '') {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Pairs emphasis delimiters, following the CommonMark algorithm (including
 * the rule of three and the openers bottom, so the work stays linear).
 */
function matchEmphasis(tokens: Token[]): void {
  const stack: Delim[] = tokens.filter((t): t is Delim => t.kind === 'delim')
  const bottom = new Map<string, number>()

  for (let ci = 0; ci < stack.length; ci++) {
    const closer = stack[ci]!
    while (closer.canClose && closer.count > 0) {
      const key = `${closer.char}${closer.canOpen ? 1 : 0}${closer.length % 3}`
      const floor = bottom.get(key) ?? -1
      let found = -1
      for (let oi = ci - 1; oi > floor; oi--) {
        const opener = stack[oi]!
        if (opener.char !== closer.char || !opener.canOpen || opener.count === 0) continue
        if (
          closer.char !== '~' &&
          (opener.canClose || closer.canOpen) &&
          (opener.length + closer.length) % 3 === 0 &&
          !(opener.length % 3 === 0 && closer.length % 3 === 0)
        ) {
          continue
        }
        found = oi
        break
      }
      if (found === -1) {
        bottom.set(key, ci - 1)
        break
      }

      const opener = stack[found]!
      const use = closer.char === '~' ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1
      const tag: Tag = closer.char === '~' ? 'del' : use === 2 ? 'strong' : 'em'
      opener.count -= use
      closer.count -= use
      opener.after.unshift({ kind: 'open', tag })
      closer.before.push({ kind: 'close', tag })

      // Delimiters between the pair can no longer match anything.
      const removed = ci - found - 1
      if (removed > 0) {
        for (const d of stack.splice(found + 1, removed)) {
          d.canOpen = false
          d.canClose = false
        }
        ci = found + 1
        for (const [k, v] of bottom) if (v > found) bottom.set(k, found)
      }
    }
  }
}

function flatten(tokens: Token[]): Inline[] {
  const out: Inline[] = []
  const push = (node: Inline) => {
    const last = out[out.length - 1]
    if (node.kind === 'text' && last?.kind === 'text') last.value += node.value
    else if (node.kind !== 'text' || node.value !== '') out.push(node)
  }
  for (const token of tokens) {
    if (token.kind === 'delim') {
      for (const n of token.before) push(n)
      push({ kind: 'text', value: token.char.repeat(token.count) })
      for (const n of token.after) push(n)
    } else {
      push(token.kind === 'text' ? { ...token } : token)
    }
  }
  return out
}

function parseInline(src: string): Inline[] {
  return new InlineParser(src, false).parse()
}

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = []
  let current: Block | null = null

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() === '') {
      if (current?.kind === 'p') current = null
      else if (current) current.blank = true
      continue
    }

    const bullet = BULLET.exec(line)
    const ordered = bullet ? null : ORDERED.exec(line)

    if (bullet) {
      if (current?.kind === 'ul') {
        current.items.push([bullet[1]!])
        current.blank = false
      } else {
        current = { kind: 'ul', start: 1, items: [[bullet[1]!]], blank: false }
        blocks.push(current)
      }
      continue
    }

    // A numbered line starts a list inside a paragraph only when it is "1.",
    // so "2024. was a good year" in running text stays text.
    if (ordered && (current?.kind !== 'p' || ordered[1] === '1')) {
      if (current?.kind === 'ol') {
        current.items.push([ordered[2]!])
        current.blank = false
      } else {
        current = { kind: 'ol', start: Number(ordered[1]), items: [[ordered[2]!]], blank: false }
        blocks.push(current)
      }
      continue
    }

    if (current && current.kind !== 'p' && (!current.blank || /^[ \t]/.test(line))) {
      current.items[current.items.length - 1]!.push(line)
      current.blank = false
      continue
    }

    if (current?.kind === 'p') {
      current.lines.push(line)
    } else {
      current = { kind: 'p', lines: [line] }
      blocks.push(current)
    }
  }
  return blocks
}

function joinLines(lines: readonly string[]): string {
  return lines.map((l) => l.trim()).join('\n')
}

function inlineToHtml(nodes: readonly Inline[]): string {
  let html = ''
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        html += escapeHtml(node.value)
        break
      case 'br':
        html += '<br>'
        break
      case 'code':
        html += `<code>${escapeHtml(node.value)}</code>`
        break
      case 'open':
        html += `<${node.tag}>`
        break
      case 'close':
        html += `</${node.tag}>`
        break
      case 'link': {
        const label = inlineToHtml(node.label)
        html +=
          node.href === null
            ? label
            : `<a href="${escapeHtml(node.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
        break
      }
    }
  }
  return html
}

function inlineToText(nodes: readonly Inline[]): string {
  let text = ''
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
      case 'code':
        text += node.value
        break
      case 'br':
        text += '\n'
        break
      case 'link': {
        const label = inlineToText(node.label)
        const url = node.url.trim()
        const shown = bareAddress(url)
        text +=
          node.href === null || label === url || label === shown ? label : `${label} (${shown})`
        break
      }
    }
  }
  return text
}

/** `mailto:a@b.c` and `tel:+1…` read as their address. */
function bareAddress(url: string): string {
  return url.replace(/^(mailto|tel):/i, '')
}

/**
 * Renders a character's answer as HTML. Only the subset characters write is
 * turned into markup: paragraphs (single line breaks become `<br>`), `**bold**`
 * and `__bold__`, `*emphasis*` and `_emphasis_`, `~~strikethrough~~`,
 * `` `code` ``, `[label](url)` links, bare http(s) URLs, and one level of `-`,
 * `*` or `1.` lists. Everything else, raw HTML included, is shown as escaped
 * text, so the result is safe to set as `innerHTML`.
 *
 * Links open in a new tab with `rel="noopener noreferrer"`. Only http, https,
 * mailto and tel links and relative or fragment URLs become links; any other
 * scheme (`javascript:`, `data:` and the like, however it is written) leaves
 * just the label as text.
 */
export function renderPersonaMarkdown(text: string): string {
  return parseBlocks(text)
    .map((block) => {
      if (block.kind === 'p') return `<p>${inlineToHtml(parseInline(joinLines(block.lines)))}</p>`
      const items = block.items
        .map((item) => `<li>${inlineToHtml(parseInline(joinLines(item)))}</li>`)
        .join('')
      if (block.kind === 'ul') return `<ul>${items}</ul>`
      return block.start === 1 ? `<ol>${items}</ol>` : `<ol start="${block.start}">${items}</ol>`
    })
    .join('')
}

/**
 * A character's answer as plain text, for notifications, SMS or any place
 * that shows no markup. Formatting marks are dropped, a link reads
 * `label (url)` (only the URL when the label is the URL; a mailto or tel
 * link shows just the address), list items keep
 * their `-` or number, and paragraphs are separated by a blank line. The
 * result is not HTML-escaped.
 */
export function personaMarkdownToText(text: string): string {
  return parseBlocks(text)
    .map((block) => {
      if (block.kind === 'p') return inlineToText(parseInline(joinLines(block.lines)))
      return block.items
        .map((item, n) => {
          const marker = block.kind === 'ul' ? '-' : `${block.start + n}.`
          return `${marker} ${inlineToText(parseInline(joinLines(item)))}`
        })
        .join('\n')
    })
    .join('\n\n')
}
