export interface Page<T> {
  data: T[]
  meta: { page: number; perPage: number; total: number }
}

export interface ListParams {
  page?: number
  perPage?: number
}

/**
 * A write answered in test mode, which every new app starts in. Nothing was
 * saved: the request input comes back with an id (a `test_` id for a create),
 * timestamps and `simulated: true`. Fields the server would have computed are
 * absent, so read them only after checking `simulated`.
 */
export type SimulatedWrite<T> = Partial<T> & {
  id: string
  createdAt: string
  updatedAt: string
  simulated: true
}

/** The saved record, or its simulated echo in test mode. Check `simulated` first. */
export type WriteResult<T> = (T & { simulated?: undefined }) | SimulatedWrite<T>

export interface RequestOptions {
  /** Replay guard for retried POSTs; server holds it 48h. */
  idempotencyKey?: string
}
