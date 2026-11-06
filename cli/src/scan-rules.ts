/**
 * The secret scan rules, shared by the CLI and the Marcapony platform.
 *
 * This file has no imports and no runtime dependencies: the platform copies it
 * verbatim and checks that its copy matches this one, so the CLI and the
 * server always judge a file the same way. Change it here only, and bump
 * RULE_SET_VERSION when a change should re-scan stored versions.
 */

export const RULE_SET_VERSION = 1

/** Files larger than this are not scanned for secrets (they are rarely source). */
export const MAX_SCAN_BYTES = 1024 * 1024

/** The line comment that exempts its own line and the line below it. */
export const ALLOW_COMMENT = 'marcapony-scan: allow'

export type RuleKind = 'provider' | 'generic'

export interface ScanFinding {
  path: string
  /** 1-based line number. */
  line: number
  ruleId: string
  /** A short English name for the rule, shown next to the path. */
  rule: string
  kind: RuleKind
  /** The matched value, cut to its first four characters. */
  masked: string
  /** True when an allow comment or the allow-list exempts it; it is still reported. */
  allowed: boolean
}

export interface ScanTextOptions {
  /**
   * `cli` honours the allow comment for every rule. `server` honours it for the
   * generic rule only: a real-looking provider key stays a finding there.
   */
  side: 'cli' | 'server'
}

interface PatternRule {
  id: string
  name: string
  kind: 'provider'
  re: RegExp
  /** Capture group holding the secret value; the whole match when omitted. */
  group?: number
  /** Extra check on the value, for rules that need more than a pattern. */
  check?: (value: string) => boolean
}

// Names that hold a value worth checking, for the rules that only fire on an
// assignment (`NAME = "value"`, `name: 'value'`, `"name": "value"`).
const ASSIGN = String.raw`["']?\s*[:=]\s*["'\x60]?`

const PROVIDER_RULES: PatternRule[] = [
  {
    id: 'marcapony-key',
    name: 'Marcapony API key',
    kind: 'provider',
    re: /\bmpk_[A-Za-z0-9]{16,}/g,
  },
  {
    id: 'artifacts-token',
    name: 'Artifacts repo token',
    kind: 'provider',
    re: /\bart_v1_[A-Za-z0-9_-]{16,}/g,
  },
  {
    id: 'stripe-key',
    name: 'Stripe secret key',
    kind: 'provider',
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  },
  {
    id: 'aws-access-key-id',
    name: 'AWS access key id',
    kind: 'provider',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'aws-secret-key',
    name: 'AWS secret access key',
    kind: 'provider',
    re: new RegExp(
      String.raw`aws_?secret_?access_?key${ASSIGN}([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])`,
      'gi',
    ),
    group: 1,
  },
  {
    id: 'gcp-service-account',
    name: 'GCP service account JSON',
    kind: 'provider',
    re: /"type"\s*:\s*"service_account"/g,
  },
  { id: 'gcp-api-key', name: 'Google API key', kind: 'provider', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    id: 'github-token',
    name: 'GitHub token',
    kind: 'provider',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/g,
  },
  {
    id: 'slack-token',
    name: 'Slack token',
    kind: 'provider',
    re: /\bxox[abposr]-[A-Za-z0-9-]{10,}|https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/g,
  },
  {
    id: 'anthropic-key',
    name: 'Anthropic API key',
    kind: 'provider',
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'openai-key',
    name: 'OpenAI API key',
    kind: 'provider',
    re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'cloudflare-token',
    name: 'Cloudflare API token',
    kind: 'provider',
    re: new RegExp(
      String.raw`\b(?:cloudflare|cf)[_-]?(?:api)?[_-]?(?:token|key)${ASSIGN}([A-Za-z0-9_-]{37,40})(?![A-Za-z0-9_-])`,
      'gi',
    ),
    group: 1,
  },
  {
    id: 'private-key',
    name: 'Private key block',
    kind: 'provider',
    re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: 'iyzico-key',
    name: 'iyzico API or secret key',
    kind: 'provider',
    re: new RegExp(
      String.raw`\biyzi(?:co)?[_-]?(?:api|secret)[_-]?key${ASSIGN}([A-Za-z0-9_-]{10,})`,
      'gi',
    ),
    group: 1,
  },
  {
    id: 'paytr-key',
    name: 'PayTR merchant key or salt',
    kind: 'provider',
    re: new RegExp(
      String.raw`\bpaytr[_-]?merchant[_-]?(?:key|salt)${ASSIGN}([A-Za-z0-9_-]{10,})`,
      'gi',
    ),
    group: 1,
  },
  {
    id: 'jwt-private-role',
    name: 'JWT with a private role',
    kind: 'provider',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    check: jwtHasPrivateRole,
  },
]

// Roles a token may carry and still be meant for client code (Supabase anon keys).
const PUBLIC_JWT_ROLES = new Set(['anon', 'anonymous', 'authenticated', 'public'])

const GENERIC_RULE = {
  id: 'generic-secret',
  name: 'High-entropy secret assignment',
  re: /([A-Za-z0-9_.-]{0,64}(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|apikey|private[_-]?key|access[_-]?key|auth[_-]?key)[A-Za-z0-9_.-]{0,64})["']?\s*[:=]\s*(["'\x60])([^"'\x60\s]{20,})\2/gi,
  nameGroup: 1,
  valueGroup: 3,
}

/** Bits per character above which a quoted value counts as random. */
export const GENERIC_ENTROPY_THRESHOLD = 3.5

// Values our templates and docs ship as placeholders.
const PLACEHOLDER_RE =
  /^(?:x{4,}|\.{3}|.*\.\.\.$|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|your[-_].*|example.*|changeme|placeholder.*|replace[-_]?me.*|dummy.*|test[-_]?(?:key|secret|token).*)$/i

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value)
}

export function isTestFixturePath(path: string): boolean {
  return /(^|\/)__fixtures__\//.test(path) || /\.test\.[A-Za-z0-9]+$/.test(path)
}

export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0
  const counts = new Map<string, number>()
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

export function maskValue(value: string): string {
  return value.length <= 4 ? '****' : `${value.slice(0, 4)}…`
}

function decodeBase64Url(segment: string): string | null {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    return atob(padded)
  } catch {
    return null
  }
}

/** A JWT is a finding only when its payload names a role that is not public. */
export function jwtHasPrivateRole(token: string): boolean {
  const payload = token.split('.')[1]
  if (!payload) return false
  const json = decodeBase64Url(payload)
  if (json === null) return false
  try {
    const claims = JSON.parse(json) as { role?: unknown }
    return typeof claims.role === 'string' && !PUBLIC_JWT_ROLES.has(claims.role.toLowerCase())
  } catch {
    return false
  }
}

/** True when the text should not be scanned: binary (a NUL byte) or over the size cap. */
export function isUnscannable(text: string, byteLength: number): boolean {
  return byteLength > MAX_SCAN_BYTES || text.includes('\u0000')
}

/**
 * Scans one text file. Returns every match, allowed ones included and marked,
 * so a summary can list what an allow comment let through.
 */
export function scanText(path: string, text: string, options: ScanTextOptions): ScanFinding[] {
  const findings: ScanFinding[] = []
  const lines = text.split('\n')
  const fixture = isTestFixturePath(path)

  lines.forEach((line, index) => {
    const commentAllows =
      line.includes(ALLOW_COMMENT) || (lines[index - 1]?.includes(ALLOW_COMMENT) ?? false)
    const seen = new Set<string>()
    const providerValues: string[] = []

    const push = (
      ruleId: string,
      rule: string,
      kind: RuleKind,
      value: string,
      allowed: boolean,
    ) => {
      const key = `${ruleId}:${value}`
      if (seen.has(key)) return
      seen.add(key)
      findings.push({
        path,
        line: index + 1,
        ruleId,
        rule,
        kind,
        masked: maskValue(value),
        allowed,
      })
    }

    for (const r of PROVIDER_RULES) {
      r.re.lastIndex = 0
      for (const match of line.matchAll(r.re)) {
        const value = match[r.group ?? 0] ?? match[0]
        if (isPlaceholder(value)) continue
        if (r.check && !r.check(value)) continue
        providerValues.push(value)
        push(r.id, r.name, 'provider', value, options.side === 'cli' && commentAllows)
      }
    }

    GENERIC_RULE.re.lastIndex = 0
    for (const match of line.matchAll(GENERIC_RULE.re)) {
      const value = match[GENERIC_RULE.valueGroup]
      if (!value || isPlaceholder(value)) continue
      if (shannonEntropy(value) <= GENERIC_ENTROPY_THRESHOLD) continue
      // A provider rule already reported this value on this line.
      if (providerValues.some((v) => value.includes(v) || v.includes(value))) continue
      push(GENERIC_RULE.id, GENERIC_RULE.name, 'generic', value, fixture || commentAllows)
    }
  })

  return findings
}

/** The findings that block: everything that is not allowed. */
export function blockingFindings(findings: ScanFinding[]): ScanFinding[] {
  return findings.filter((f) => !f.allowed)
}
