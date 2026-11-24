/**
 * Follow the customer portal's theme when the app is shown inside the portal.
 *
 * The portal sends `{ type: 'mp:theme', theme }` to the framed app after it
 * loads, when the app posts `{ type: 'mp:ready' }`, and whenever the visitor
 * switches between light and dark or the owner edits the theme. This writes the
 * colours, radius and font onto the CSS variables `styles.css` reads. Outside
 * the portal nothing arrives and the defaults in `styles.css` apply.
 *
 * Only messages from the parent window are read, and every value is checked
 * before it reaches a style.
 */

const COLORS: ReadonlyArray<readonly [string, string]> = [
  ['background', '--background'],
  ['foreground', '--foreground'],
  ['card', '--card'],
  ['primary', '--primary'],
  ['primaryForeground', '--primary-foreground'],
  ['muted', '--muted'],
  ['mutedForeground', '--muted-foreground'],
  ['destructive', '--destructive'],
  ['border', '--border'],
  ['ring', '--ring'],
]

const RGB = /^rgb\(\d{1,3} \d{1,3} \d{1,3}\)$/
const RADIUS = /^\d+(\.\d+)?(rem|px|em)$/
const FONT_STACK = /^[\w\s"',-]{1,200}$/

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function followPortalTheme(root: HTMLElement = document.documentElement): void {
  if (window.parent === window) return

  // A theme can leave out values the portal could not read: drop what the
  // previous one set and this one omits, so the default from styles.css returns.
  let applied: string[] = []
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return
    const message = asRecord(event.data)
    if (message?.type !== 'mp:theme') return
    const theme = asRecord(message?.theme)
    if (!theme) return

    const next = new Map<string, string>()
    const colors = asRecord(theme.colors) ?? {}
    for (const [key, variable] of COLORS) {
      const value = colors[key]
      if (typeof value === 'string' && RGB.test(value)) next.set(variable, value)
    }
    if (typeof theme.radius === 'string' && RADIUS.test(theme.radius)) {
      next.set('--radius', theme.radius)
    }
    if (typeof theme.fontFamily === 'string' && FONT_STACK.test(theme.fontFamily)) {
      next.set('--font-sans', theme.fontFamily)
    }
    for (const name of applied) {
      if (!next.has(name)) root.style.removeProperty(name)
    }
    for (const [name, value] of next) root.style.setProperty(name, value)
    applied = [...next.keys()]
    const dark = theme.appearance === 'dark'
    root.dataset.appearance = dark ? 'dark' : 'light'
    root.style.colorScheme = dark ? 'dark' : 'light'
  })

  // Ask for the current theme now that the listener is in place.
  window.parent.postMessage({ type: 'mp:ready' }, '*')
}
