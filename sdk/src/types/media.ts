export type AssetFileType = 'all' | 'image' | 'document' | 'video' | 'other'

export interface Asset {
  id: string
  name: string
  mimeType: string
  size: number
  /** S3 key, e.g. `acme/3fa85f64-….webp`. */
  path: string
  url: string | null
  width: number | null
  height: number | null
  aspectRatio: number | null
  /** Keyed by locale. Empty until the media pipeline has written one. */
  altText: Record<string, string>
  variants: Record<string, unknown> | null
  /** Non-null only while variants, alt text and embeddings are still being produced. */
  processingStatus: string | null
  createdAt: string
  updatedAt: string | null
}

export interface ImportAssetInput {
  /** https only, publicly reachable. Private and loopback hosts are refused. */
  url: string
  name?: string
  /** Pass this with an extension when the URL has none — the S3 key is built from it. */
  fileName?: string
  folderId?: string
}
