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

/** The image types `me.media.upload` takes. */
export type SellerImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/avif'

/** The largest image `me.media.upload` takes, in bytes (10 MB). */
export const SELLER_IMAGE_MAX_BYTES = 10 * 1024 * 1024

export interface SellerImageUploadOptions {
  /** Required unless `data` is a Blob or File that carries its type. */
  contentType?: SellerImageType
  /** Shown in the tenant's media library; the extension is taken from the type. */
  fileName?: string
  /** Makes the upload safe to retry; without one it is sent exactly once. */
  idempotencyKey?: string
}

/** An image a seller uploaded, ready for `imageIds`. */
export interface SellerImage {
  id: string
  name: string
  mimeType: string
}
