/** Thin HTTP layer over the two endpoints the CLI uses. Zero dependencies. */

export interface LinkResponse {
  appSlug: string | null
  environmentName: string
  key: string
  baseUrl: string
}

export interface DeploymentView {
  id: string
  status: 'uploading' | 'live' | 'failed' | 'superseded'
  hostname: string | null
  error: string | null
  createdAt?: string
}

export interface DeploymentRequest {
  worker: { main: string; content: string; encoding: 'base64' }
  compatibilityDate?: string
  compatibilityFlags?: string[]
  vars?: Record<string, string>
  assets?: Array<{ path: string; content: string; contentType: string }>
  assetsConfig?: Record<string, unknown>
  placement?: 'portal' | 'public'
  permissions?: Array<{ id: string; label: string; grants: string[] }>
  portal?: { title?: string; icon?: string; sortOrder?: number }
  assetsBinding?: string
}

export interface SourceGrant {
  repoName: string
  remote: string
  branch: string
  token: string
  expiresAt: string | null
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

export class CliError extends Error {}

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
  if (typeof err === 'string') return new CliError(err)
  if (err && typeof err === 'object') {
    const { code, message } = err as { code?: string; message?: string }
    return new CliError(message ? `${message}${code ? ` (${code})` : ''}` : `HTTP ${res.status}`)
  }
  return new CliError(`Request failed with status ${res.status}`)
}

export async function exchangeCode(
  apiRoot: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkResponse> {
  const res = await fetchImpl(`${apiRoot}/apps/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!res.ok) throw await failure(res)
  return (await res.json()) as LinkResponse
}

export async function createDeployment(
  apiRoot: string,
  apiKey: string,
  payload: DeploymentRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<DeploymentView> {
  const res = await fetchImpl(`${apiRoot}/ext/v1/deployments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw await failure(res)
  return ((await res.json()) as { data: DeploymentView }).data
}

export async function fetchDeployment(
  apiRoot: string,
  apiKey: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
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
  fetchImpl: typeof fetch = fetch,
): Promise<Capability[]> {
  const res = await fetchImpl(`${apiRoot}/ext/v1/capabilities`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw await failure(res)
  return ((await res.json()) as { data: Capability[] }).data
}

/**
 * Ask the platform for a short-lived source write grant. Returns null when the
 * platform has source storage switched off (503) or the endpoint does not exist
 * yet (404), so an older or unconfigured environment simply skips the push.
 */
export async function fetchSourceGrant(
  apiRoot: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SourceGrant | null> {
  const res = await fetchImpl(`${apiRoot}/ext/v1/deployments/source-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (res.status === 503 || res.status === 404) return null
  if (!res.ok) throw await failure(res)
  return ((await res.json()) as { data: SourceGrant }).data
}
