export interface Page<T> {
  data: T[]
  meta: { page: number; perPage: number; total: number }
}

export interface ListParams {
  page?: number
  perPage?: number
}

export interface RequestOptions {
  /** Replay guard for retried POSTs; server holds it 48h. */
  idempotencyKey?: string
}
