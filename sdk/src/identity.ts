/**
 * Verification of the `x-marcapony-identity` token the platform attaches to a
 * request that comes from a signed-in portal visitor. For display and for
 * hiding buttons: the platform enforces access itself on every `/me` call, so
 * a wrong answer here can never expose data, only show the wrong UI.
 */

export const IDENTITY_HEADER = 'x-marcapony-identity'
const JWKS_PATH = '/.well-known/marcapony-identity-keys.json'
const JWKS_TTL_MS = 5 * 60_000
const JWKS_MISS_REFETCH_MS = 60_000
const JWKS_FAILURE_BACKOFF_MS = 5_000
const CLOCK_SKEW_SECONDS = 5

export interface Identity {
  /** The portal user id. */
  sub: string
  kind: 'customer' | 'member'
  email: string
  /** Permission ids the app declared in marcapony.json that this person holds. */
  permissions: string[]
  can(permission: string): boolean
  /**
   * True when an owner or staff member is previewing the app (for example "view
   * as customer"). The platform simulates every write of such a request, so an
   * app should show a banner rather than pretend the change was saved.
   */
  preview: boolean
}

interface Jwk {
  kty: string
  crv: string
  x: string
  y: string
  kid: string
}

interface KeyCache {
  keys: Map<string, CryptoKey>
  fetchedAt: number
}

export interface IdentityVerifierOptions {
  /** The app id (`MARCAPONY_APP_ID`); the token audience must be `app:<appId>`. */
  appId: string
  /** The `/ext/v1` base URL; the JWKS lives on its origin. */
  baseUrl: string
  fetch: typeof globalThis.fetch
  now?: () => number
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export function createIdentityVerifier(options: IdentityVerifierOptions) {
  const origin = new URL(options.baseUrl).origin
  const now = options.now ?? (() => Date.now())
  let cache: KeyCache | null = null
  let lastMissRefetch = 0
  let lastFailedFetch = -Infinity

  async function fetchKeys(): Promise<KeyCache | null> {
    try {
      const response = await options.fetch(`${origin}${JWKS_PATH}`)
      if (!response.ok) return null
      const body = (await response.json()) as { keys?: Jwk[] }
      const keys = new Map<string, CryptoKey>()
      for (const jwk of body.keys ?? []) {
        if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.kid) continue
        keys.set(
          jwk.kid,
          await crypto.subtle.importKey(
            'jwk',
            { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify'],
          ),
        )
      }
      if (keys.size === 0) return null
      return { keys, fetchedAt: now() }
    } catch {
      return null
    }
  }

  async function keyFor(kid: string): Promise<CryptoKey | null> {
    // Fail closed: once the cache is past its lifetime it is never trusted
    // again, so a failed refetch means no identity rather than stale keys
    // (a revoked or rotated-out key must stop verifying).
    if (!cache || now() - cache.fetchedAt > JWKS_TTL_MS) {
      cache = null
      if (now() - lastFailedFetch >= JWKS_FAILURE_BACKOFF_MS) {
        cache = await fetchKeys()
        if (!cache) lastFailedFetch = now()
      }
    }
    const known = cache?.keys.get(kid)
    if (known) return known
    // An unknown kid after a rotation: refetch, but not on every forged token.
    if (cache && now() - lastMissRefetch > JWKS_MISS_REFETCH_MS) {
      lastMissRefetch = now()
      const refreshed = await fetchKeys()
      if (refreshed) cache = refreshed
      return cache.keys.get(kid) ?? null
    }
    return null
  }

  return async function verify(token: string | null | undefined): Promise<Identity | null> {
    if (!token) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
    const headerBytes = fromBase64Url(headerPart)
    const payloadBytes = fromBase64Url(payloadPart)
    const signature = fromBase64Url(signaturePart)
    if (!headerBytes || !payloadBytes || !signature) return null
    try {
      const header = JSON.parse(new TextDecoder().decode(headerBytes)) as {
        alg?: unknown
        kid?: unknown
      }
      if (header.alg !== 'ES256' || typeof header.kid !== 'string') return null
      const key = await keyFor(header.kid)
      if (!key) return null
      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        signature,
        new TextEncoder().encode(`${headerPart}.${payloadPart}`),
      )
      if (!valid) return null

      const claims = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, unknown>
      const seconds = Math.floor(now() / 1000)
      if (claims.aud !== `app:${options.appId}`) return null
      if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= seconds) return null
      if (typeof claims.iat === 'number' && claims.iat > seconds + CLOCK_SKEW_SECONDS) return null
      if (typeof claims.sub !== 'string' || typeof claims.email !== 'string') return null
      if (claims.kind !== 'customer' && claims.kind !== 'member') return null
      const permissions = Array.isArray(claims.perm)
        ? claims.perm.filter((p): p is string => typeof p === 'string')
        : []
      return {
        sub: claims.sub,
        kind: claims.kind,
        email: claims.email,
        permissions,
        can: (permission: string) => permissions.includes(permission),
        preview: claims.prv === true,
      }
    } catch {
      return null
    }
  }
}
