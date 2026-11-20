import { MarcaponyError } from '../errors.js'
import { path, type ApiPath } from '../path.js'
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

/**
 * The records of one collection: the signed-in customer's on
 * `forRequest(request).me.records`, the app's own (a shared collection) on
 * `records`.
 */
export interface RecordCollectionClient<T extends RecordData = RecordData> {
  /** The record under this key, or null when there is none. */
  get: (key: string) => Promise<AppRecord<T> | null>
  /** One page of records. See `ListRecordsParams` for the filters. */
  list: (params?: ListRecordsParams) => Promise<RecordPage<T>>
  /** Creates the record under this key or replaces it whole. */
  put: (key: string, data: T, options?: PutRecordOptions) => Promise<RecordWriteResult<T>>
  /** Creates a record under a generated key. */
  create: (data: T, options?: RequestOptions) => Promise<RecordWriteResult<T>>
  /** Deletes the record. Resolves false when there was none under this key. */
  delete: (key: string, options?: DeleteRecordOptions) => Promise<boolean>
}

const isMissingRecord = (err: unknown): boolean =>
  err instanceof MarcaponyError && err.status === 404 && err.code === 'not_found'

const ifMatch = (version: number | undefined): Record<string, string> | undefined =>
  version === undefined ? undefined : { 'If-Match': String(version) }

/** Where a collection's records live: the customer's own, or the app's shared ones. */
export type RecordStore = 'me' | 'shared'

function collectionPath(store: RecordStore, collection: string): ApiPath {
  return store === 'me' ? path`/me/records/${collection}` : path`/records/${collection}`
}

function recordPath(store: RecordStore, collection: string, key: string): ApiPath {
  return store === 'me'
    ? path`/me/records/${collection}/${key}`
    : path`/records/${collection}/${key}`
}

/**
 * A collection the app declares under `collections` in `marcapony.json`.
 *
 * - `me`: a customer collection. The platform takes the customer from the
 *   verified identity, so nothing here can reach another customer's records.
 * - `shared`: a collection declared with `"scope": "shared"`, whose records
 *   belong to the app. Who may read and write it is the collection's own
 *   `read` and `write`; a writer it does not list answers
 *   `PermissionDeniedError` with code `write_not_allowed`.
 *
 * The environment comes from the key, so a test environment never sees
 * production's. A collection that is not declared (or not deployed yet), or
 * one of the other kind, answers `NotFoundError` with code
 * `collection_not_found` on every call, `get` included: only a missing record
 * is null.
 */
export function recordsResource(t: Transport, store: RecordStore = 'me') {
  return <T extends RecordData = RecordData>(collection: string): RecordCollectionClient<T> => ({
    get: async (key) => {
      try {
        return unwrap(
          await t.request<{ data: AppRecord<T> }>({
            method: 'GET',
            path: recordPath(store, collection, key),
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
        path: collectionPath(store, collection),
        query: params,
      }),
    put: (key, data, options) =>
      t
        .request<{ data: RecordWriteResult<T> }>({
          method: 'PUT',
          path: recordPath(store, collection, key),
          body: { data },
          headers: ifMatch(options?.ifVersion),
          idempotencyKey: options?.idempotencyKey,
        })
        .then(unwrap),
    create: (data, options) =>
      t
        .request<{ data: RecordWriteResult<T> }>({
          method: 'POST',
          path: collectionPath(store, collection),
          body: { data },
          idempotencyKey: options?.idempotencyKey,
        })
        .then(unwrap),
    delete: async (key, options) => {
      try {
        unwrap(
          await t.request<{ data: unknown }>({
            method: 'DELETE',
            path: recordPath(store, collection, key),
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
