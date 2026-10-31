/**
 * Public types for the Marcapony external API (/ext/v1).
 *
 * These mirror the API's frozen response views, not internal domain models.
 * They are hand-written on purpose, so the public contract cannot drift with
 * an internal refactor. Fields are added over the life of v1, never removed or
 * retyped.
 */

export interface Page<T> {
  data: T[]
  meta: { page: number; perPage: number; total: number }
}

export interface SiteInfo {
  id: string
  name: string
  slug: string
  domain: string
  country: string
  defaultLocale: string
  supportedLocales: string[]
  defaultCurrency: string
}

export interface Country {
  code: string
  name: string
  regionCode: string
  currencyCode: string
  currencySymbol: string
  phoneCode: string
  languageCode: string
  localeCode: string
}

export interface Product {
  id: string
  name: string
  slug: string
  status: number
  description: string
  categoryId: string | null
  categoryName: string | null
  categorySlug: string | null
  price: number | null
  salePrice: number | null
  currency: string | null
  stock: number | null
  trackStock: boolean
  requiresShipping: boolean
  imageIds: string[]
  coverImageId: string | null
  createdAt: string
  updatedAt: string
}

export interface Category {
  id: string
  name: string
  slug: string
  description: string | null
  parentId: string | null
  productsCount: number
}

export interface HighlightedProduct {
  id: string
  productId: string
  categoryId: string | null
  highlightOrder: number
  product: Record<string, unknown> | null
}

export interface Customer {
  id: string
  name: string
  email: string
  phone: string | null
  address: string | null
  orderCount: number
  totalSpent: number
  status: number
  createdAt: string
  updatedAt: string
}

export interface Reservation {
  id: string
  customerId: string | null
  requestedDate: string
  requestedTime: string
  duration: number | null
  status: string | number
  notes: string | null
  orderId: string | null
  approvedAt: string | null
  rejectedAt: string | null
  createdAt: string | null
  updatedAt: string | null
  customerName: string | null
  customerEmail: string | null
  customerPhone: string | null
  productName: string | null
}

/** A reservation of the signed-in customer (`me.reservations`), with the deposit state. */
export interface OwnReservation extends Reservation {
  depositAmount: number | null
  depositCurrency: string | null
  depositStatus: 'pending' | 'paid' | 'refunded' | 'forfeited' | 'needs_refund' | 'released' | null
  depositRefundCutoffHours: number | null
  depositPaidAt: string | null
}

export type ReservationStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'completed'

/** Filters of `me.reservations.list`; they only narrow the customer's own list. */
export interface ListOwnReservationsParams {
  page?: number
  perPage?: number
  status?: ReservationStatus
  /** YYYY-MM-DD, inclusive. */
  from?: string
  /** YYYY-MM-DD, inclusive. */
  to?: string
}

/** The signed-in customer's own record (`me.profile.get`). */
export interface MeProfile {
  id: string
  name: string
  email: string
  phone: string | null
  address: string | null
  createdAt: string
}

export type PaymentLinkStatus = 'pending' | 'paid' | 'expired' | 'cancelled' | 'refunded'

/** A payment link addressed to the signed-in customer (`me.paymentLinks`). */
export interface OwnPaymentLink {
  id: string
  linkId: string
  title: string
  description: string | null
  amount: number
  currency: string
  lineItems: unknown[]
  status: PaymentLinkStatus
  expiresAt: string | null
  discountAmount: number | null
  orderId: string | null
  createdAt: string
  paidAt: string | null
  cancelledAt: string | null
}

/** A form the signed-in customer sent: metadata only, never the answers. */
export interface OwnFormSubmission {
  id: string
  formId: string
  formName: string | null
  submittedAt: string
}

export interface AvailabilityBlock {
  id: string
  blockType: string
  title: string | null
  startDate: string
  endDate: string | null
  startTime: string
  endTime: string
  isFullDay: boolean
  recurrenceDays: number[] | null
  createdAt: string
}

export interface OrderItem {
  id: string
  productId: string
  productVariantId: string | null
  variantLabel: string | null
  productName: string
  quantity: number
  price: number
  totalPrice: number
  currency: string
  requiresShipping: boolean
}

export interface Order {
  id: string
  orderNumber: number | null
  customerId: string | null
  currency: string | null
  buyerName: string | null
  buyerEmail: string | null
  buyerPhone: string | null
  source: string
  shippingAddress: Record<string, unknown> | null
  billingAddress: Record<string, unknown> | null
  totalAmount: number
  discountAmount: number
  shippingAmount: number
  taxAmount: number
  discountId: string | null
  status: number
  paymentStatus: number
  paymentMethod: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface OrderWithItems extends Order {
  items: OrderItem[]
}

export interface PaymentLinkLineItem {
  name: string
  price: number
  quantity: number
  productId?: string
  categoryId?: string
  variant?: string | null
}

export interface PaymentLink {
  id: string
  linkId: string
  customerId: string | null
  customerName: string | null
  customerEmail: string | null
  title: string
  description: string | null
  amount: number
  currency: string
  lineItems: PaymentLinkLineItem[]
  status: string
  expiresAt: string | null
  successUrl: string | null
  provider: string
  discountId: string | null
  discountAmount: number | null
  orderId: string | null
  createdAt: string
  updatedAt: string
  paidAt: string | null
  cancelledAt: string | null
}

export interface Discount {
  id: string
  name: string
  code: string | null
  discountType: string
  percentage: number | null
  fixedAmount: number | null
  currency: string | null
  startDate: string | null
  endDate: string | null
  maxUses: number | null
  usageCount: number
  minPurchaseAmount: number | null
  appliesTo: string
  targetIds: string[]
  status: number
  createdAt: string
  updatedAt: string
}

export interface FormSubmission {
  id: string
  formId: string
  locale: string
  data: Record<string, unknown>
  submittedAt: string
}

export interface CreateCustomerInput {
  name: string
  email: string
  phone?: string
  address?: string
}

export interface CreateReservationInput {
  customerId?: string
  customerName: string
  customerEmail: string
  customerPhone?: string
  /** YYYY-MM-DD */
  requestedDate: string
  /** HH:mm */
  requestedTime: string
  /** Minutes, 15–480 */
  duration?: number
  notes?: string
  customFields?: Array<{ key: string; label: string; value: string }>
  /**
   * 'slots' (default) books on the account's availability grid — the time
   * must be a generated slot inside working hours. 'free' books an arbitrary
   * wall-clock time (a transfer leaves when the flight lands, not on a
   * 15-minute grid); the merchant's availability blocks and busy calendar
   * events still apply.
   */
  timeMode?: 'slots' | 'free'
  /**
   * 'single' (default) rejects a second booking overlapping the same time.
   * 'unlimited' allows simultaneous bookings (five cars can leave at 14:30).
   */
  capacityMode?: 'single' | 'unlimited'
}

export interface UpdateReservationStatusInput {
  status: 'approved' | 'rejected' | 'cancelled' | 'completed'
  rejectionReason?: string
}

export interface CreateOrderInput {
  /** Costs are derived from the catalog server-side; no client amounts. */
  items: Array<{ productId: string; productVariantId?: string; quantity: number }>
  discountCode?: string
  shippingAddress?: OrderAddressInput
  billingAddress?: OrderAddressInput
  notes?: string
}

export interface OrderAddressInput {
  address: string
  city: string
  country: string
  zipCode: string
  contactName?: string
}

export interface CreatePaymentLinkInput {
  title: string
  description?: string
  amount: number
  currency?: string
  lineItems?: PaymentLinkLineItem[]
  /** ISO datetime */
  expiresAt?: string
  /** Must be on one of the account's verified domains (or a subdomain). */
  successUrl?: string
  installmentOptions?: number[]
  customerId?: string
  sendEmail?: boolean
  discountCode?: string
}

export interface SubmitFormInput {
  formId: string
  formMode: string
  submissionData: Record<string, unknown>
  name?: string
  email?: string
  phone?: string
  address?: string
  message?: string
  productId?: string
  turnstileToken?: string | null
}

export interface PostAuthor {
  id: string | null
  slug: string | null
  displayName: string | null
  title: string | null
  avatarUrl: string | null
}

export interface PostCategory {
  id: string
  name: string
  slug: string
}

export type PostKind = 'article' | 'event'
export type PostRelationType = 'tags' | 'ids' | 'no-relation'

export interface Post {
  id: string
  title: string
  slug: string
  /** Sanitized HTML. Scripts, event handlers and iframes are stripped server-side. */
  content: string
  excerpt: string
  locale: string
  isPublished: boolean
  isFeatured: boolean
  publishedAt: string | null
  /** Asset id of the cover image, not a URL. Resolve it with `media.get`. */
  imageId: string | null
  imageUrl: string | null
  metaDescription: string | null
  tags: string[]
  author: PostAuthor | null
  categories: PostCategory[]
  /**
   * The TRANSLATION pointer: null on an original, the original post's id on a
   * translation. Related content is `relationType` + `relatedPostIds`, which
   * are a different mechanism entirely.
   */
  translationOfPostId: string | null
  relationType: PostRelationType
  relatedPostIds: string[]
  showReadingTime: boolean
  readingTime: number | null
  allowComments: boolean
  postKind: PostKind
  /**
   * Wall-clock local time at the venue: `YYYY-MM-DDTHH:mm(:ss)`, never with a
   * `Z` suffix and never with an offset. NOT an instant — do not pass it
   * through `new Date()` and re-serialize, and do not convert it between time
   * zones. The platform stores these as TIMESTAMP without a time zone because
   * a 20:00 concert must read as 20:00 everywhere.
   */
  eventStartAt: string | null
  eventEndAt: string | null
  eventLocation: string | null
  createdAt: string
  updatedAt: string
}

export interface CreatePostInput {
  title: string
  /** HTML. Sanitized server-side. */
  content: string
  excerpt?: string
  metaDescription?: string
  /** Asset id. Obtain one with `media.list` or `media.upload`. */
  imageId?: string
  tags?: string[]
  isFeatured?: boolean
  authorId?: string | null
  categoryIds?: string[]
  relationType?: PostRelationType
  /** Required and non-empty when `relationType` is `'ids'`. */
  relatedPostIds?: string[]
  showReadingTime?: boolean
  allowComments?: boolean
  postKind?: PostKind
  /** Wall-clock, no time zone. See `Post.eventStartAt`. */
  eventStartAt?: string
  eventEndAt?: string
  eventLocation?: string
}

export type UpdatePostInput = CreatePostInput

export interface CreatePostTranslationInput {
  locale: string
  title: string
  content: string
  excerpt?: string
  metaDescription?: string
  tags?: string[]
}

export type BlogAuthorSourceType = 'platform_user' | 'portal_customer'

export interface BlogAuthor {
  id: string
  slug: string
  displayName: string
  title: string | null
  bio: string | null
  avatarUrl: string | null
  socialLinks: Record<string, string>
  sourceType: BlogAuthorSourceType
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateBlogAuthorInput {
  sourceType: BlogAuthorSourceType
  /** Unique per account together with `sourceType`. */
  sourceId: string
  slug: string
  displayName: string
  title?: string | null
  bio?: string | null
  avatarUrl?: string | null
  socialLinks?: Record<string, string>
  isActive?: boolean
}

/** `sourceType` and `sourceId` identify who the profile is for and cannot change. */
export type UpdateBlogAuthorInput = Partial<Omit<CreateBlogAuthorInput, 'sourceType' | 'sourceId'>>

export interface BlogCategory {
  id: string
  name: string
  slug: string
  description: string | null
  locale: string
  /** Same pattern posts use: null on an original, the original's id on a translation. */
  translationOfCategoryId: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateBlogCategoryInput {
  name: string
  /** Derived from the name when omitted. */
  slug?: string
  description?: string
  locale?: string
  status?: 'active' | 'archived'
  sortOrder?: number
}

export type UpdateBlogCategoryInput = Partial<CreateBlogCategoryInput>

export interface CreateBlogCategoryTranslationInput {
  locale: string
  name: string
  slug?: string
  description?: string
}

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
