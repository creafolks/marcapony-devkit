/** Thin HTTP layer over the endpoints the CLI uses. Zero dependencies. */

import { SDK_VERSION_HEADER, cliFetch } from './client-info.js'

export interface LinkResponse {
  appSlug: string | null
  environmentName: string
  key: string
  baseUrl: string
  /** Absent on platforms older than key rotation. */
  keyId?: string
  expiresAt?: string | null
}

/** What the platform says about the key in use. */
export interface KeyInfo {
  id: string
  expiresAt: string | null
  /** `ci` for a key made with `marcapony app link --ci`, `local` for a project key. */
  cliLabel: 'local' | 'ci' | 'session' | 'dev' | null
}

export interface DeploymentView {
  id: string
  status: 'uploading' | 'live' | 'failed' | 'superseded'
  hostname: string | null
  error: string | null
  createdAt?: string
  /** Things the deploy did not fail on but the owner should fix, such as a required value not set. */
  warnings?: string[]
  /**
   * Newer versions of the CLI or the SDK, as structured data; the same text is
   * in `warnings`. Absent on platforms that do not send notices.
   */
  notices?: DeployNotice[]
}

/** A newer CLI or SDK is available. Informational: it never blocks a deploy. */
export interface DeployNotice {
  kind: 'cli_update' | 'sdk_update'
  /** The version in use; null when the platform could not tell. */
  current: string | null
  latest: string
  /** The command that updates it. */
  command: string
}

export interface DeploymentRequest {
  worker: { main: string; content: string; encoding: 'base64' }
  compatibilityDate?: string
  compatibilityFlags?: string[]
  vars?: Record<string, string>
  assets?: Array<{ path: string; content: string; contentType: string }>
  assetsConfig?: Record<string, unknown>
  placement?: 'portal' | 'public'
  dataAccess?: 'account' | 'visitor' | 'customer' | 'team'
  permissions?: Array<{ id: string; label: string; grants: string[] }>
  portal?: { title?: string; icon?: string; sortOrder?: number }
  assetsBinding?: string
  /** The source commit pushed for this deploy, so the platform can show it as a version. */
  source?: DeploymentSource
  /** The head this project last synced with; the server refuses the deploy if it moved. */
  baseSourceRef?: string | null
  /** Replace commits this project has not seen. Recorded on the deployment. */
  force?: boolean
  /** A version 2 marcapony.json, sent as written; the platform translates it. */
  manifest?: Record<string, unknown>
  /**
   * Use the one-time direct deploy the owner allowed in the dashboard, for a
   * production that otherwise goes live through releases only.
   */
  direct?: boolean
}

/** What `POST /ext/v1/deployments/validate` checks before the build. */
export type ValidateRequest = Pick<
  DeploymentRequest,
  | 'placement'
  | 'dataAccess'
  | 'permissions'
  | 'portal'
  | 'baseSourceRef'
  | 'force'
  | 'manifest'
  | 'direct'
> & { withSource?: boolean }

export interface DeploymentSource {
  commit: string
  message?: string
  fileCount?: number
  sizeBytes?: number
  /** The write grant the commit was pushed with. */
  grantId?: string
}

/** The source repo's working set against its limit, as last measured by the platform. */
export interface SourceUsage {
  usedBytes: number
  limitBytes: number
  /** Every blob the repo ever held, reachable or not; approximate. */
  historyBytes: number
  measuredAt: string
}

export interface SourceGrant {
  repoName: string
  remote: string
  branch: string
  token: string
  expiresAt: string | null
  /** Absent on platforms older than push grants. */
  grantId?: string
  headBefore?: string | null
  /** Absent on platforms older than the source quota; null until first measured. */
  sourceUsage?: SourceUsage | null
}

export type SourceReadGrant = Omit<SourceGrant, 'grantId' | 'headBefore' | 'sourceUsage'>

/**
 * Who moved the environment's head. For an approved change committed by the
 * platform, `kind` is `proposal`, `proposedBy` says who wrote it and `name`
 * who approved it; `version` is null until its build deployed it. For a git
 * push whose build has not deployed yet, `kind` is `push` and `name` is the
 * pusher (null for a push with a deploy key).
 */
export interface MovedBy {
  name: string | null
  version: number | null
  at: string
  forced: boolean
  kind?: 'proposal' | 'push'
  proposalId?: string
  proposedBy?: 'marco' | 'mcp' | 'system'
}

const PROPOSERS: Record<NonNullable<MovedBy['proposedBy']>, string> = {
  marco: "Marco's change",
  mcp: "An AI agent's change",
  system: 'A platform change',
}

/**
 * "Ayşe deployed version 15", "Marco's change, approved by Ayşe (version 15)",
 * or "Ayşe force-pushed". A push says whether it was forced itself, in words,
 * so the line reads well inside the parentheses `pull` puts around it.
 */
export function describeMovedBy(movedBy: MovedBy): string {
  if (movedBy.kind === 'push') {
    if (movedBy.name) return `${movedBy.name} ${movedBy.forced ? 'force-pushed' : 'pushed'}`
    return movedBy.forced ? 'A forced git push' : 'A git push'
  }
  const version = movedBy.version === null ? '' : ` (version ${movedBy.version})`
  if (movedBy.kind === 'proposal') {
    const change = (movedBy.proposedBy && PROPOSERS[movedBy.proposedBy]) || 'An approved change'
    return `${change}, approved by ${movedBy.name ?? 'someone'}${version}`
  }
  return movedBy.version === null
    ? `${movedBy.name ?? 'Someone'} deployed`
    : `${movedBy.name ?? 'Someone'} deployed version ${movedBy.version}`
}

export interface SourceHead {
  /** False when the platform does not store source for this environment. */
  enabled: boolean
  environmentId?: string
  branch: string
  head: string | null
  /** True when the platform could not reach the store and answered from its record. */
  stale: boolean
  /** The head's scan status; null while the platform does not scan yet. */
  scan: 'pending' | 'clean' | 'blocked' | null
  movedBy: MovedBy | null
  /** Old commit -> new commit, after the platform rewrote history. */
  rewrites: Record<string, string>
  /** Absent on platforms older than the source quota; null until first measured. */
  sourceUsage?: SourceUsage | null
}

/**
 * One entry from `GET /ext/v1/capabilities` — the scope-filtered operations
 * this key can call, each with its SDK call and input/response shape, as the
 * platform's capability catalog describes it.
 */
export interface Capability {
  id: string
  scope: string
  method: string
  path: string
  summary: string
  sdk: string
  input: string | null
  response: string
  idempotent: boolean
  requiresPlugin: string | null
  notes: string[]
}

/**
 * Stable exit codes, so scripts and agents can branch on the outcome without
 * reading the message: 0 done, 2 the remote has changes this project has not
 * pulled, 3 a pull left conflicts, 4 the server refused, 5 not linked, 6 the
 * secret scan found possible secrets, 7 not logged in.
 */
export const EXIT = {
  ok: 0,
  failed: 1,
  remoteChanges: 2,
  conflicts: 3,
  refused: 4,
  notLinked: 5,
  /** `marcapony scan` found possible secrets. */
  secretsFound: 6,
  /** Not logged in, or the login expired or was revoked: run `marcapony login`. */
  loginRequired: 7,
} as const

export class CliError extends Error {
  readonly code: string | undefined
  readonly status: number | undefined
  readonly exitCode: number
  constructor(
    message: string,
    options: { code?: string; status?: number; exitCode?: number } = {},
  ) {
    super(message)
    this.code = options.code
    this.status = options.status
    this.exitCode =
      options.exitCode ??
      (options.code === 'remote_changes'
        ? EXIT.remoteChanges
        : options.code === 'login_required'
          ? EXIT.loginRequired
          : options.status !== undefined && options.status >= 400 && options.status < 500
            ? EXIT.refused
            : EXIT.failed)
  }
}

/**
 * Both surfaces answer with a message we can show verbatim: `/ext/v1` uses the
 * frozen `{ error: { code, message } }` envelope, `/apps/link` a plain
 * `{ error: string }`. Never print the response body raw — it can carry a key.
 */
async function failure(res: Response): Promise<CliError> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  const err = (body as { error?: unknown } | null)?.error
  const status = res.status
  if (typeof err === 'string') return new CliError(err, { status })
  if (err && typeof err === 'object') {
    const { code, message } = err as { code?: string; message?: string }
    return new CliError(message ? `${message}${code ? ` (${code})` : ''}` : `HTTP ${status}`, {
      code,
      status,
    })
  }
  return new CliError(`Request failed with status ${status}`, { status })
}

export async function exchangeCode(
  apiRoot: string,
  code: string,
  fetchImpl: typeof fetch = cliFetch,
  options: { ci?: boolean } = {},
): Promise<LinkResponse> {
  const res = await fetchImpl(`${apiRoot}/apps/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options.ci ? { code, ci: true } : { code }),
  })
  if (!res.ok) throw await failure(res)
  return (await res.json()) as LinkResponse
}

/**
 * Create the deployment. While the platform re-measures a source repo that
 * was over its limit (409 source_quota_pending, typically right after the push
 * that removed the large file), it waits as told by Retry-After, for up to a
 * minute in all.
 */
export async function createDeployment(
  apiRoot: string,
  apiKey: string,
  payload: DeploymentRequest,
  fetchImpl: typeof fetch = cliFetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  options: { sdkVersion?: string | null } = {},
): Promise<DeploymentView> {
  let waited = 0
  for (;;) {
    const res = await fetchImpl(`${apiRoot}/ext/v1/deployments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        // The project's SDK version, so the platform can say when a newer one is out.
        ...(options.sdkVersion ? { [SDK_VERSION_HEADER]: options.sdkVersion } : {}),
      },
      body: JSON.stringify(payload),
    })
    if (res.ok) return ((await res.json()) as { data: DeploymentView }).data
    const error = await failure(res)
    if (error.code !== 'source_quota_pending' || waited >= 60_000) throw error
    const seconds = Number(res.headers.get('Retry-After') ?? '10')
    const ms = Math.min(Math.max(Number.isFinite(seconds) ? seconds : 10, 1), 30) * 1000
    await sleep(ms)
    waited += ms
  }
}

export async function fetchDeployment(
  apiRoot: string,
  apiKey: string,
  id: string,
  fetchImpl: typeof fetch = cliFetch,
): Promise<DeploymentView> {
  const res = await fetchImpl(`${apiRoot}/ext/v1/deployments/${id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw await failure(res)
  return ((await res.json()) as { data: DeploymentView }).data
}

export async function fetchCapabilities(
  apiRoot: string,
  apiKey: string,
  fetchImpl: typeof fetch = cliFetch,
): Promise<Capability[]> {
  const res = await fetchImpl(`${apiRoot}/ext/v1/capabilities`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw await failure(res)
  return ((await res.json()) as { data: Capability[] }).data
}

/**
 * Ask the platform for a short-lived source write grant, right before the push.
 * Returns null when the platform has source storage switched off (503) or the
 * endpoint does not exist yet (404), so an older or unconfigured environment
 * simply skips the push. While another writer holds the app's one open grant
 * (409 source_push_in_progress) it waits as told by Retry-After, for up to a
 * minute in all.
 */
export async function fetchSourceGrant(
  apiRoot: string,
  apiKey: string,
  fetchImpl: typeof fetch = cliFetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  options: { direct?: boolean } = {},
): Promise<SourceGrant | null> {
  let waited = 0
  const query = options.direct ? '?direct=true' : ''
  for (;;) {
    const res = await fetchImpl(`${apiRoot}/ext/v1/deployments/source-token${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (res.status === 503 || res.status === 404) return null
    if (res.ok) return ((await res.json()) as { data: SourceGrant }).data
    const error = await failure(res)
    if (error.code !== 'source_push_in_progress' || waited >= 60_000) throw error
    const seconds = Number(res.headers.get('Retry-After') ?? '5')
    const ms = Math.min(Math.max(Number.isFinite(seconds) ? seconds : 5, 1), 30) * 1000
    await sleep(ms)
    waited += ms
  }
}

/** Close a write grant right after the push. Errors are the caller's to ignore. */
export async function closeSourceGrant(
  apiRoot: string,
  apiKey: string,
  grantId: string,
  fetchImpl: typeof fetch = cliFetch,
): Promise<{ outcome: string | null; headAfter: string | null }> {
  const res = await fetchImpl(
    `${apiRoot}/ext/v1/deployments/source-token/${encodeURIComponent(grantId)}/close`,
    { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` } },
  )
  if (!res.ok) throw await failure(res)
  return ((await res.json()) as { data: { outcome: string | null; headAfter: string | null } }).data
}

/** A short-lived read token for `marcapony app pull`; null when there is no source yet. */
export async function fetchSourceReadGrant(
  apiRoot: string,
  apiKey: string,
  fetchImpl: typeof fetch = cliFetch,
): Promise<SourceReadGrant | null> {
  const res = await fetchImpl(`${apiRoot}/ext/v1/deployments/source-read-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (res.status === 404 || res.status === 503) return null
  if (!res.ok) throw await failure(res)
  return ((await res.json()) as { data: SourceReadGrant }).data
}

/**
 * The environment's branch head as the platform tracks it. Null on a platform
 * older than the sync rule (404), which the CLI treats as "nothing to check".
 */
export async function fetchSourceHead(
  apiRoot: string,
  apiKey: string,
  fetchImpl: typeof fetch = cliFetch,
): Promise<SourceHead | null> {
  const res = await fetchImpl(`${apiRoot}/ext/v1/deployments/source-head`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  // 400, 404 and 405 mean the route is not there. A platform older than the
  // route answers this path through `GET /deployments/:id`, which fails with a
  // server error, so this version is published after the platform. A 5xx is
  // never read as "no sync": that would skip the head check during an outage.
  if (res.status === 400 || res.status === 404 || res.status === 405) return null
  if (!res.ok) throw await failure(res)
  const data = ((await res.json()) as { data?: Partial<SourceHead> }).data
  if (!data || typeof data.enabled !== 'boolean') return null
  return data as SourceHead
}

/**
 * Every check of a deploy that needs no bundle. Throws the server's refusal;
 * resolves false on a platform older than the route (404).
 */
export async function validateDeployment(
  apiRoot: string,
  apiKey: string,
  payload: ValidateRequest,
  fetchImpl: typeof fetch = cliFetch,
): Promise<boolean> {
  const res = await fetchImpl(`${apiRoot}/ext/v1/deployments/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  })
  if (res.status === 404) return false
  if (!res.ok) throw await failure(res)
  return true
}

/**
 * Revoke this user's earlier project keys for the same environment, called
 * with the new key once it is written. Keys of other users and pipeline keys
 * are left alone by the platform. Null on a platform older than the route.
 */
export async function retirePreviousKeys(
  apiRoot: string,
  apiKey: string,
  fetchImpl: typeof fetch = cliFetch,
): Promise<number | null> {
  const res = await fetchImpl(`${apiRoot}/ext/v1/keys/retire-previous`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (res.status === 400 || res.status === 404 || res.status === 405) return null
  if (!res.ok) throw await failure(res)
  const body = (await res.json()) as { data?: { revoked?: number }; revoked?: number }
  return body.data?.revoked ?? body.revoked ?? 0
}

/**
 * The key's own record (expiry and label), or null when the platform does not
 * say (an older platform has no such route).
 */
export async function fetchKeyInfo(
  apiRoot: string,
  apiKey: string,
  fetchImpl: typeof fetch = cliFetch,
): Promise<KeyInfo | null> {
  const res = await fetchImpl(`${apiRoot}/ext/v1/keys/current`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) return null
  const body = (await res.json().catch(() => null)) as { data?: Partial<KeyInfo> } | null
  const info = body?.data
  if (info && typeof info.id === 'string' && info.expiresAt !== undefined) {
    return { id: info.id, expiresAt: info.expiresAt ?? null, cliLabel: info.cliLabel ?? null }
  }
  return null
}

/** A change the owner approved and handed over to the developers, as `marcapony app proposals list` shows it. */
export interface HandedOverChange {
  id: string
  status: string
  summary: string | null
  baseCommit: string
  approvedAt: string | null
  approvedBy: string | null
  fileCount?: number
}

/** One file of a handed-over change: the content on its base and the proposed content (null deletes it). */
export interface HandedOverFile {
  path: string
  op: 'edit' | 'create' | 'delete'
  baseContent: string | null
  content: string | null
}

export interface HandedOverChangeDetail extends HandedOverChange {
  files: HandedOverFile[]
}

/** The key environment's handed-over changes. */
export async function fetchHandedOverChanges(
  apiRoot: string,
  apiKey: string,
  fetchImpl: typeof fetch = cliFetch,
): Promise<HandedOverChange[]> {
  const res = await fetchImpl(`${apiRoot}/ext/v1/proposals`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw await failure(res)
  return ((await res.json()) as { data: HandedOverChange[] }).data
}

/** One handed-over change with its files. */
export async function fetchHandedOverChange(
  apiRoot: string,
  apiKey: string,
  id: string,
  fetchImpl: typeof fetch = cliFetch,
): Promise<HandedOverChangeDetail> {
  const res = await fetchImpl(`${apiRoot}/ext/v1/proposals/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw await failure(res)
  return ((await res.json()) as { data: HandedOverChangeDetail }).data
}
