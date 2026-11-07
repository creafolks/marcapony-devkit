import { CliError } from './api.js'

/**
 * The platform routes behind `marcapony login`: the device flow, the login
 * credential's own routes (`/ext/v1/cli/*`), and releases from the terminal.
 * A credential is sent only to these routes and only as a bearer header.
 */

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  interval: number
  expiresIn: number
}

export interface LoginGrant {
  credential: string
  credentialId: string
  expiresAt: string
  user: { id: string; email: string | null }
  account: { id: string; name: string | null; slug: string | null }
}

export interface LinkableApp {
  id: string
  name: string
  slug: string
  environments: Array<{
    id: string
    name: string
    liveDeploymentId: string | null
    liveVersion: number | null
  }>
}

export interface MintedKey {
  key: string
  keyId: string
  expiresAt: string | null
  appId: string
  appSlug: string
  environmentId: string
  environmentName: string
  baseUrl: string
}

export interface Release {
  id: string
  number: number
  label: string | null
  kind: 'promote' | 'rollback' | 'mark'
  title: string
  status: 'pending' | 'committing' | 'deploying' | 'live' | 'failed'
  failureStep: 'bundle' | 'commit' | 'deploy' | null
  error: string | null
  createdAt: string
  liveAt: string | null
  commitCount: number | null
}

export interface ReleasePreview {
  deploymentId: string
  version: number
  sourceEnvironmentName: string
  commitCount: number | null
  olderThanPreviousRelease: boolean
  productionMoved: boolean
  productionCommits: Array<{ sha: string; message: string }>
  missingValues: string[]
  blockers: string[]
  warnings?: string[]
  commitAvailable: boolean
}

/**
 * Both shapes the routes answer with: `{ error: { code, message } }` from the
 * credential surface and the device flow, `{ code, message }` from the
 * release services. Never echoes the body raw.
 */
async function failure(res: Response): Promise<CliError> {
  let body: Record<string, unknown> | null = null
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    body = null
  }
  const nested = body?.error
  const { code, message } =
    nested && typeof nested === 'object'
      ? (nested as { code?: string; message?: string })
      : { code: body?.code as string | undefined, message: body?.message as string | undefined }
  const text =
    typeof nested === 'string' ? nested : (message ?? `Request failed with status ${res.status}`)
  const err = new CliError(code ? `${text} (${code})` : text, { code, status: res.status })
  ;(err as CliError & { details?: unknown }).details = body
  return err
}

async function call<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit & { credential?: string } = {},
): Promise<T> {
  const { credential, ...rest } = init
  const res = await fetchImpl(url, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
  })
  if (!res.ok) throw await failure(res)
  if (res.status === 204) return undefined as T
  const body = (await res.json()) as unknown
  // The credential routes wrap in `{ data }`; the release services do not.
  return (
    body && typeof body === 'object' && 'data' in body ? (body as { data: T }).data : body
  ) as T
}

export function requestDeviceCode(
  apiRoot: string,
  client: { clientName: string; hostname?: string; os?: string; cliVersion?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCode> {
  return call(fetchImpl, `${apiRoot}/cli/device-codes`, {
    method: 'POST',
    body: JSON.stringify(client),
  })
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'ok'; grant: LoginGrant }

/** One poll of the device flow; RFC 8628 answers become a status. */
export async function pollDeviceToken(
  apiRoot: string,
  deviceCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PollResult> {
  try {
    return {
      status: 'ok',
      grant: await call<LoginGrant>(fetchImpl, `${apiRoot}/cli/device-tokens`, {
        method: 'POST',
        body: JSON.stringify({ deviceCode }),
      }),
    }
  } catch (err) {
    const code = err instanceof CliError ? err.code : undefined
    if (code === 'authorization_pending') return { status: 'pending' }
    if (code === 'slow_down') return { status: 'slow_down' }
    if (code === 'access_denied') return { status: 'denied' }
    if (code === 'expired_token') return { status: 'expired' }
    throw err
  }
}

export interface LoginMe {
  user: { id: string; email: string | null }
  account: { id: string; name: string; slug: string } | null
  credential: { id: string; clientName: string | null; expiresAt: string | null }
}

export const fetchMe = (apiRoot: string, credential: string, fetchImpl: typeof fetch = fetch) =>
  call<LoginMe>(fetchImpl, `${apiRoot}/ext/v1/cli/me`, { credential })

export const fetchLinkableApps = async (
  apiRoot: string,
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkableApp[]> =>
  (await call<{ apps: LinkableApp[] }>(fetchImpl, `${apiRoot}/ext/v1/cli/apps`, { credential }))
    .apps

export const mintSessionKey = (
  apiRoot: string,
  credential: string,
  target: { appId: string; environment: string },
  fetchImpl: typeof fetch = fetch,
) =>
  call<MintedKey>(fetchImpl, `${apiRoot}/ext/v1/cli/sessions`, {
    method: 'POST',
    credential,
    body: JSON.stringify(target),
  })

export const mintDevKey = (
  apiRoot: string,
  credential: string,
  target: { appId: string; environment: string },
  fetchImpl: typeof fetch = fetch,
) =>
  call<MintedKey>(fetchImpl, `${apiRoot}/ext/v1/cli/dev-keys`, {
    method: 'POST',
    credential,
    body: JSON.stringify(target),
  })

export const revokeOldKey = (
  apiRoot: string,
  credential: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
) =>
  call<{ revoked: boolean }>(fetchImpl, `${apiRoot}/ext/v1/cli/keys/revoke`, {
    method: 'POST',
    credential,
    body: JSON.stringify({ key }),
  })

export const revokeCurrentLogin = (
  apiRoot: string,
  credential: string,
  fetchImpl: typeof fetch = fetch,
) =>
  call<{ revoked: boolean }>(fetchImpl, `${apiRoot}/ext/v1/cli/credentials/current`, {
    method: 'DELETE',
    credential,
  })

const releases = (apiRoot: string, appId: string) =>
  `${apiRoot}/ext/v1/cli/apps/${encodeURIComponent(appId)}/releases`

export const listReleases = (
  apiRoot: string,
  credential: string,
  appId: string,
  fetchImpl: typeof fetch = fetch,
) => call<Release[]>(fetchImpl, releases(apiRoot, appId), { credential })

export const getRelease = (
  apiRoot: string,
  credential: string,
  appId: string,
  releaseId: string,
  fetchImpl: typeof fetch = fetch,
) => call<Release>(fetchImpl, `${releases(apiRoot, appId)}/${releaseId}`, { credential })

export const previewRelease = (
  apiRoot: string,
  credential: string,
  appId: string,
  deploymentId: string,
  fetchImpl: typeof fetch = fetch,
) =>
  call<ReleasePreview>(
    fetchImpl,
    `${releases(apiRoot, appId)}/preview?deploymentId=${encodeURIComponent(deploymentId)}`,
    { credential },
  )

export type CreateReleaseBody =
  | {
      kind: 'promote'
      deploymentId: string
      title: string
      notes?: string
      overwrite?: boolean
      acknowledgeWarnings?: boolean
    }
  | { kind: 'rollback'; releaseId: string; title?: string; notes?: string }

export const createRelease = (
  apiRoot: string,
  credential: string,
  appId: string,
  body: CreateReleaseBody,
  fetchImpl: typeof fetch = fetch,
) =>
  call<Release>(fetchImpl, releases(apiRoot, appId), {
    method: 'POST',
    credential,
    body: JSON.stringify(body),
  })

export const retryRelease = (
  apiRoot: string,
  credential: string,
  appId: string,
  releaseId: string,
  fetchImpl: typeof fetch = fetch,
) =>
  call<Release>(fetchImpl, `${releases(apiRoot, appId)}/${releaseId}/retry`, {
    method: 'POST',
    credential,
  })
