import { path } from '../path.js'
import { create, get, list, type Transport } from '../transport.js'
import type {
  Asset,
  AssetFileType,
  ImportAssetInput,
  ListParams,
  Page,
  RequestOptions,
} from '../types/index.js'

export function mediaResource(t: Transport) {
  return {
    /** One page of media assets; `q` is a search term, `fileType` narrows the kind. */
    list: (params?: ListParams & { q?: string; fileType?: AssetFileType }): Promise<Page<Asset>> =>
      list(t, path`/media`, params),
    /** One asset by id. */
    get: (id: string): Promise<Asset> => get(t, path`/media/${id}`),
    /** Imports a file from a public https URL into the media library. */
    upload: (input: ImportAssetInput, options?: RequestOptions): Promise<Asset> =>
      create(t, path`/media`, input, options),
  }
}

export type MediaResource = ReturnType<typeof mediaResource>
