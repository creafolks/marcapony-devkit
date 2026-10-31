/**
 * Calls this app's own `/api` routes. The interface never talks to Marcapony
 * directly: the app key lives on the server and must stay there.
 */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? (init?.body === undefined ? 'GET' : 'POST'),
    headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body.error ?? `Request failed with status ${response.status}`,
    )
  }
  return body as T
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed'
}

/** One id per user action, reused when that action is retried. */
export function newRequestId(): string {
  return crypto.randomUUID()
}
