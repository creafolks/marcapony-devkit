import { MarcaponyError } from '../errors.js'
import { path } from '../path.js'
import { unwrap, type Transport } from '../transport.js'
import type {
  AppRecord,
  DeleteRecordOptions,
  ListRecordsParams,
  PutRecordOptions,
  RecordData,
  RecordPage,
  RecordWriteResult,
  RequestOptions,
} from '../types/index.js'

/** The signed-in customer's records in one collection. */
export interface RecordCollectionClient<T extends RecordData = RecordData> {
  /** The record under this key, or null when the customer has none. */
  get: (key: string) => Promise<AppRecord<T> | null>
  /** One page of the customer's records. See `ListRecordsParams` for the filters. */
  list: (params?: ListRecordsParams) => Promise<RecordPage<T>>
  /** Creates the record under this key or replaces it whole. */
  put: (key: string, data: T, options?: PutRecordOptions) => Promise<RecordWriteResult<T>>
  /** Creates a record under a generated key. */
  create: (data: T, options?: RequestOptions) => Promise<RecordWriteResult<T>>
  /** Deletes the record. Resolves false when the customer had none under this key. */
  delete: (key: string, options?: DeleteRecordOptions) => Promise<boolean>
}

const isMissingRecord = (err: unknown): boolean =>
  err instanceof MarcaponyError && err.status === 404 && err.code === 'not_found'

const ifMatch = (version: number | undefined): Record<string, string> | undefined =>
  version === undefined ? undefined : { 'If-Match': String(version) }

/**
 * A collection the app declares under `collections` in `marcapony.json`. The
 * platform takes the customer from the verified identity and the environment
 * from the key, so nothing here can reach another customer's records, and a
 * test environment never sees production's.
 *
 * A collection that is not declared (or not deployed yet) answers
 * `NotFoundError` with code `collection_not_found` on every call, `get`
 * included: only a missing record is null.
 */
export function recordsResource(t: Transport) {
  return <T extends RecordData = RecordData>(collection: string): RecordCollectionClient<T> => ({
    get: async (key) => {
      try {
        return unwrap(
          await t.request<{ data: AppRecord<T> }>({
            method: 'GET',
            path: path`/me/records/${collection}/${key}`,
          }),
        )
      } catch (err) {
        if (isMissingRecord(err)) return null
        throw err
      }
    },
    list: (params) =>
      t.request<RecordPage<T>>({
        method: 'GET',
        path: path`/me/records/${collection}`,
        query: params,
      }),
    put: (key, data, options) =>
      t
        .request<{ data: RecordWriteResult<T> }>({
          method: 'PUT',
          path: path`/me/records/${collection}/${key}`,
          body: { data },
          headers: ifMatch(options?.ifVersion),
          idempotencyKey: options?.idempotencyKey,
        })
        .then(unwrap),
    create: (data, options) =>
      t
        .request<{ data: RecordWriteResult<T> }>({
          method: 'POST',
          path: path`/me/records/${collection}`,
          body: { data },
          idempotencyKey: options?.idempotencyKey,
        })
        .then(unwrap),
    delete: async (key, options) => {
      try {
        unwrap(
          await t.request<{ data: unknown }>({
            method: 'DELETE',
            path: path`/me/records/${collection}/${key}`,
            headers: ifMatch(options?.ifVersion),
          }),
        )
        return true
      } catch (err) {
        if (isMissingRecord(err)) return false
        throw err
      }
    },
  })
}
