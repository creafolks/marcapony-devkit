import { path } from '../path.js'
import { recordsResource } from './records.js'
import { create, get, list, remove, replace, unwrap, update, type Transport } from '../transport.js'
import { ValidationError } from '../errors.js'
import type {
  CreateOwnReservationInput,
  HeldVariantsResult,
  ListSellerProductsParams,
  ProductVariant,
  ProductVariantInput,
  SellerImage,
  SellerImageUploadOptions,
  SellerProduct,
  SellerProductInput,
  UpdateSellerProductInput,
  ListOwnReservationsParams,
  ListParams,
  MeProfile,
  Order,
  OrderWithItems,
  OwnFormSubmission,
  OwnPaymentLink,
  OwnReservation,
  Page,
  PaymentLinkStatus,
  RequestOptions,
  WriteResult,
} from '../types/index.js'
import { SELLER_IMAGE_MAX_BYTES } from '../types/media.js'

export function meResource(t: Transport) {
  return {
    profile: {
      /** The signed-in customer's own record. */
      get: (): Promise<MeProfile> => get(t, path`/me/profile`),
    },
    reservations: {
      /** One page of the customer's reservations, with the deposit state. */
      list: (params?: ListOwnReservationsParams): Promise<Page<OwnReservation>> =>
        list(t, path`/me/reservations`, params),
      /** One of the customer's reservations; another customer's id answers 404. */
      get: (id: string): Promise<OwnReservation> => get(t, path`/me/reservations/${id}`),
      /** Books a reservation for the signed-in customer. */
      create: (
        input: CreateOwnReservationInput,
        options?: RequestOptions,
      ): Promise<WriteResult<OwnReservation>> => create(t, path`/me/reservations`, input, options),
      /** Cancels one of the customer's reservations. */
      cancel: (id: string): Promise<WriteResult<{ id: string; status: 'cancelled' }>> =>
        update(t, path`/me/reservations/${id}`, { status: 'cancelled' }),
    },
    orders: {
      /** One page of the customer's orders. */
      list: (params?: ListParams): Promise<Page<Order>> => list(t, path`/me/orders`, params),
      /** One of the customer's orders with its line items. */
      get: (id: string): Promise<OrderWithItems> => get(t, path`/me/orders/${id}`),
    },
    paymentLinks: {
      /** One page of the payment links addressed to the customer. */
      list: (params?: ListParams & { status?: PaymentLinkStatus }): Promise<Page<OwnPaymentLink>> =>
        list(t, path`/me/payment-links`, params),
      /** One payment link addressed to the customer. */
      get: (id: string): Promise<OwnPaymentLink> => get(t, path`/me/payment-links/${id}`),
    },
    /** Metadata only: entries are linked by the e-mail typed into the form, so the answers are never returned. */
    formSubmissions: {
      /** One page of the forms the customer sent: which form and when. */
      list: (params?: ListParams): Promise<Page<OwnFormSubmission>> =>
        list(t, path`/me/form-submissions`, params),
    },
    /**
     * The customer's records in a collection the app declares in
     * `marcapony.json`: `records<Entry>('entries').put(key, data)`.
     */
    records: recordsResource(t),
    /**
     * A marketplace seller's own products (a customer the tenant gave a seller
     * role, through a portal app; needs the `products.own.read` /
     * `products.own.write` grants). Products start as drafts and go live
     * through `submit`: the team reviews them, unless the tenant turned review
     * off. Another seller's product, or one of the team's, answers 404.
     */
    products: {
      /** One page of the seller's products, every status. */
      list: (params?: ListSellerProductsParams): Promise<Page<SellerProduct>> =>
        list(t, path`/me/products`, params),
      /** One of the seller's products, with its review state. */
      get: (id: string): Promise<SellerProduct> => get(t, path`/me/products/${id}`),
      /** Creates a draft. Counts toward the tenant's per-seller limit. */
      create: (input: SellerProductInput, options?: RequestOptions): Promise<SellerProduct> =>
        create(t, path`/me/products`, input, options),
      /**
       * Updates a product. On a live product under review, stock applies at
       * once and every other field waits for the team in `pendingChanges`.
       */
      update: (id: string, input: UpdateSellerProductInput): Promise<SellerProduct> =>
        update(t, path`/me/products/${id}`, input),
      /** The variant combinations. Needs the variants plugin. */
      variants: (id: string): Promise<ProductVariant[]> =>
        get(t, path`/me/products/${id}/variants`),
      /**
       * Replaces the variant combinations. On a live product under review the
       * set waits for the team instead (`heldForReview`). Needs the variants plugin.
       */
      setVariants: (
        id: string,
        input: { combinations: ProductVariantInput[] },
      ): Promise<ProductVariant[] | HeldVariantsResult> =>
        replace(t, path`/me/products/${id}/variants`, input),
      /** Sends a draft to the team (or publishes it when review is off). */
      submit: (id: string): Promise<SellerProduct> => create(t, path`/me/products/${id}/submit`),
      /** Takes a live product off the site; a waiting edit becomes part of the draft. */
      unpublish: (id: string): Promise<SellerProduct> =>
        create(t, path`/me/products/${id}/unpublish`),
      /** Deletes a product that is not live; unpublish a live one first. */
      delete: (id: string): Promise<void> => remove(t, path`/me/products/${id}`),
    },
    media: {
      /**
       * Uploads an image for the seller's products: jpeg, png, webp, gif or
       * avif, at most 10 MB, sent as the raw bytes. Use the returned id in
       * `imageIds`. A seller may keep a limited number of images no product
       * uses yet.
       */
      upload: (
        data: ArrayBuffer | Uint8Array | Blob,
        options: SellerImageUploadOptions = {},
      ): Promise<SellerImage> => {
        const isBlob = typeof Blob !== 'undefined' && data instanceof Blob
        const contentType = options.contentType ?? (isBlob ? (data as Blob).type : '')
        if (!contentType) {
          return Promise.reject(
            new ValidationError(400, 'validation_failed', 'Pass contentType for the image bytes'),
          )
        }
        const size = isBlob ? (data as Blob).size : (data as ArrayBuffer | Uint8Array).byteLength
        if (size === 0 || size > SELLER_IMAGE_MAX_BYTES) {
          return Promise.reject(
            new ValidationError(400, 'validation_failed', 'An image must be 1 byte to 10 MB'),
          )
        }
        return t
          .request<{ data: SellerImage }>({
            method: 'POST',
            path: path`/me/media`,
            rawBody: { data, contentType },
            headers: options.fileName
              ? { 'X-File-Name': encodeURIComponent(options.fileName) }
              : undefined,
            idempotencyKey: options.idempotencyKey,
          })
          .then(unwrap)
      },
    },
  }
}

/**
 * The calls a signed-in customer may make about themselves. The platform takes
 * the customer from the verified identity on every call; nothing here can name
 * another customer, and another customer's id answers 404.
 */
export type MeClient = ReturnType<typeof meResource>
