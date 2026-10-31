export interface MarcaponyClientOptions {
  /** An app API key (`mpk_...`). MCP (`mcp_`) keys cannot open this surface. */
  apiKey: string
  /** Defaults to the production API. */
  baseUrl?: string
  /** Custom fetch (tests, instrumentation). Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch
  /** Per-request timeout. Default 30 000 ms. */
  timeoutMs?: number
  /**
   * Retries for idempotent requests on 429/5xx/network errors. POSTs retry
   * only when an idempotencyKey accompanies them. Default 2.
   */
  maxRetries?: number
  /**
   * The SDK refuses to run with a secret key in a browser: a key in a bundle
   * is public, and a public key can mint payment links. Only set this if you
   * fully understand that exposure.
   */
  dangerouslyAllowBrowser?: boolean
  /**
   * The app's id (`MARCAPONY_APP_ID`). Needed by `identity()` to check the token
   * audience; the CLI injects it at deploy.
   */
  appId?: string
}

/** The options after validation and defaults, shared by every transport of one client. */
export interface ResolvedOptions {
  apiKey: string
  /** Without a trailing slash. */
  baseUrl: string
  fetch: typeof globalThis.fetch
  timeoutMs: number
  maxRetries: number
  appId: string | null
}

const DEFAULT_BASE_URL = 'https://api.marcapony.com/ext/v1'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 2

export function resolveOptions(options: MarcaponyClientOptions): ResolvedOptions {
  if (!options.apiKey) {
    throw new Error('marcapony-sdk: apiKey is required')
  }
  if (runsInBrowser() && options.apiKey.startsWith('mpk_') && !options.dangerouslyAllowBrowser) {
    throw new Error(
      'marcapony-sdk: refusing to run with a secret API key in a browser. ' +
        'Keys in bundles are public. Call the API from your backend, or pass ' +
        'dangerouslyAllowBrowser: true if you truly accept the exposure.',
    )
  }
  return {
    apiKey: options.apiKey,
    baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    appId: options.appId ?? null,
  }
}

/**
 * `window` alone misses browser Web/Service Workers, which do ship in a
 * publicly downloadable bundle (exactly what the guard exists to stop), and
 * false-positives in non-browser runtimes that define `window`.
 */
function runsInBrowser(): boolean {
  return (
    typeof document !== 'undefined' ||
    typeof (globalThis as { importScripts?: unknown }).importScripts === 'function'
  )
}
