import { createIdentityVerifier, IDENTITY_HEADER, type Identity } from './identity.js'
import {
  errorFromResponse,
  MarcaponyError,
  RateLimitError,
  ServerError,
  UnauthorizedError,
} from './errors.js'
import type {
  Asset,
  AssetFileType,
  AvailabilityBlock,
  BlogAuthor,
  BlogAuthorSourceType,
  BlogCategory,
  Category,
  Country,
  CreateBlogAuthorInput,
  CreateBlogCategoryInput,
  CreateBlogCategoryTranslationInput,
  CreateCustomerInput,
  CreateOrderInput,
  CreatePaymentLinkInput,
  CreatePostInput,
  CreatePostTranslationInput,
  CreateReservationInput,
  Customer,
  Discount,
  FormSubmission,
  HighlightedProduct,
  ImportAssetInput,
  Order,
  OrderWithItems,
  Page,
  PaymentLink,
  Post,
  PostKind,
  Product,
  Reservation,
  SiteInfo,
  SubmitFormInput,
  UpdateBlogAuthorInput,
  UpdateBlogCategoryInput,
  UpdatePostInput,
  UpdateReservationStatusInput,
} from './types.js'

export * from './errors.js'
export { IDENTITY_HEADER, type Identity } from './identity.js'
export * from './types.js'

export interface MarcaponyClientOptions {
  /** An app API key (`mpk_...`). MCP (`mcp_`) keys cannot open this surface. */
  apiKey: string
  /** Defaults to the production API. Point at staging for tests. */
  baseUrl?: string
  /** Custom fetch (tests, instrumentation). Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch
  /** Per-request timeout. Default 30 000 ms. */
  timeoutMs?: number
  /**
   * Retries for idempotent requests on 429/5xx/network errors. POSTs retry
   * only when an idempotencyKey accompanies them. Default 2.
   */
  maxRetries?: number
  /**
   * The SDK refuses to run with a secret key in a browser: a key in a bundle
   * is public, and a public key can mint payment links. Only set this if you
   * fully understand that exposure.
   */
  dangerouslyAllowBrowser?: boolean
  /**
   * The app's id (`MARCAPONY_APP_ID`). Needed by `identity()` to check the token
   * audience; the CLI injects it at deploy.
   */
  appId?: string
}

export interface RequestOptions {
  /** Replay guard for retried POSTs; server holds it 48h. */
  idempotencyKey?: string
}

interface RequestArgs {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  query?: object
  body?: unknown
  idempotencyKey?: string
}

const DEFAULT_BASE_URL = 'https://api.marcapony.com/ext/v1'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 2
/**
 * Ceiling on an honored `Retry-After`. The backoff sleep is deliberately
 * outside the per-attempt abort controller, so `timeoutMs` does not bound it —
 * without a cap a `Retry-After: 3600` from an edge limiter would block the
 * caller for an hour inside what looks like a 30s-timeout request. Anything
 * longer is surfaced as a RateLimitError for the caller to schedule.
 */
const MAX_RETRY_DELAY_MS = 60_000

class Transport {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly extraHeaders: Record<string, string>

  constructor(options: MarcaponyClientOptions, extraHeaders: Record<string, string> = {}) {
    if (!options.apiKey) {
      throw new Error('marcapony-sdk: apiKey is required')
    }
    // `window` alone misses browser Web/Service Workers — which do ship in a
    // publicly downloadable bundle, exactly what this guard exists to stop —
    // and false-positives in non-browser runtimes that define `window`.
    const inBrowser =
      typeof document !== 'undefined' ||
      typeof (globalThis as { importScripts?: unknown }).importScripts === 'function'
    if (inBrowser && options.apiKey.startsWith('mpk_') && !options.dangerouslyAllowBrowser) {
      throw new Error(
        'marcapony-sdk: refusing to run with a secret API key in a browser. ' +
          'Keys in bundles are public. Call the API from your backend, or pass ' +
          'dangerouslyAllowBrowser: true if you truly accept the exposure.',
      )
    }
    this.apiKey = options.apiKey
    this.extraHeaders = extraHeaders
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  }

  async request<T>(args: RequestArgs): Promise<T> {
    const url = new URL(this.baseUrl + args.path)
    for (const [key, value] of Object.entries(args.query ?? {}) as Array<[string, unknown]>) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = {
      ...this.extraHeaders,
      Authorization: `Bearer ${this.apiKey}`,
    }
    if (args.body !== undefined) headers['Content-Type'] = 'application/json'
    if (args.idempotencyKey) headers['Idempotency-Key'] = args.idempotencyKey

    const retryable = args.method === 'GET' || Boolean(args.idempotencyKey)
    const attempts = retryable ? this.maxRetries + 1 : 1

    let lastError: unknown = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        const base = 500 * 2 ** (attempt - 1)
        const retryAfter =
          lastError instanceof RateLimitError && lastError.retryAfter
            ? Math.min(lastError.retryAfter * 1000, MAX_RETRY_DELAY_MS)
            : null
        await sleep(retryAfter ?? base)
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetchImpl(url.toString(), {
          method: args.method,
          headers,
          body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
          signal: controller.signal,
        })

        let parsed: unknown = null
        let unparseableBody = false
        try {
          const text = await response.text()
          parsed = text.length > 0 ? JSON.parse(text) : null
        } catch {
          unparseableBody = true
        }

        if (response.ok) {
          // A 2xx whose body did not parse is a truncated or proxy-mangled
          // response, not an empty one. Returning null here surfaced later as
          // an opaque TypeError in the caller's code with nothing pointing at
          // the transport — treat it as a retryable server failure instead.
          if (unparseableBody) {
            lastError = new ServerError(
              response.status,
              'server_error',
              `${args.method} ${args.path} → ${response.status}: response body was not valid JSON`,
            )
            continue
          }
          return parsed as T
        }

        const error = errorFromResponse(
          response.status,
          parsed as Parameters<typeof errorFromResponse>[1],
          response.headers.get('Retry-After'),
          { method: args.method, path: args.path },
        )
        if (response.status === 429 || response.status >= 500) {
          // Honoring a Retry-After beyond the cap would stall the caller far
          // past its own timeout; hand the decision back instead.
          if (
            error instanceof RateLimitError &&
            error.retryAfter !== null &&
            error.retryAfter * 1000 > MAX_RETRY_DELAY_MS
          ) {
            throw error
          }
          lastError = error
          continue
        }
        throw error
      } catch (err) {
        if (err instanceof MarcaponyError) throw err
        lastError = err
      } finally {
        clearTimeout(timer)
      }
    }

    if (lastError instanceof MarcaponyError) throw lastError
    throw new ServerError(
      0,
      'server_error',
      `${args.method} ${args.path} failed after ${attempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface ListParams {
  page?: number
  perPage?: number
}

export interface ListPostsFilters {
  /** Strings, not booleans: the surface takes them as query values. */
  published?: 'true' | 'false'
  featured?: 'true' | 'false'
  locale?: string
  categoryId?: string
  kind?: PostKind
  q?: string
}

export interface ListBlogAuthorsFilters {
  page?: number
  limit?: number
  query?: string
  sourceType?: BlogAuthorSourceType
  isActive?: boolean
}

/** One path segment for a record id: encoded, and never `.`/`..` which a URL would resolve away. */
function pathId(id: string): string {
  if (!id || id === '.' || id === '..') {
    throw new Error('marcapony-sdk: invalid record id')
  }
  return encodeURIComponent(id)
}

function meClient(t: Transport): MeClient {
  return {
    reservations: {
      list: (params?: ListParams) =>
        t.request<Page<Reservation>>({ method: 'GET', path: '/me/reservations', query: params }),
      get: (id: string) =>
        t
          .request<{ data: Reservation }>({ method: 'GET', path: `/me/reservations/${pathId(id)}` })
          .then(unwrap),
      create: (input: CreateOwnReservationInput, options?: RequestOptions) =>
        t
          .request<{ data: Reservation }>({
            method: 'POST',
            path: '/me/reservations',
            body: input,
            idempotencyKey: options?.idempotencyKey,
          })
          .then(unwrap),
      cancel: (id: string) =>
        t
          .request<{ data: { id: string; status: 'cancelled' } }>({
            method: 'PATCH',
            path: `/me/reservations/${pathId(id)}`,
            body: { status: 'cancelled' },
          })
          .then(unwrap),
    },
    orders: {
      list: (params?: ListParams) =>
        t.request<Page<Order>>({ method: 'GET', path: '/me/orders', query: params }),
      get: (id: string) =>
        t
          .request<{ data: OrderWithItems }>({ method: 'GET', path: `/me/orders/${pathId(id)}` })
          .then(unwrap),
    },
  }
}

/**
 * The account routes a team member's identity reaches (a member tool opened
 * from the dashboard). The platform intersects the key's scopes with the
 * member's grants and role on every call; a customer's identity gets 403
 * `scoped_route_required` here and must use `me`.
 */
function memberClient(t: Transport): MemberClient {
  return {
    reservations: {
      list: (params?: ListParams) =>
        t.request<Page<Reservation>>({ method: 'GET', path: '/reservations', query: params }),
      get: (id: string) =>
        t
          .request<{ data: Reservation }>({ method: 'GET', path: `/reservations/${pathId(id)}` })
          .then(unwrap),
      create: (input: CreateReservationInput, options?: RequestOptions) =>
        t
          .request<{ data: unknown }>({
            method: 'POST',
            path: '/reservations',
            body: input,
            idempotencyKey: options?.idempotencyKey,
          })
          .then(unwrap),
      updateStatus: (id: string, input: UpdateReservationStatusInput) =>
        t
          .request<{ data: unknown }>({
            method: 'PATCH',
            path: `/reservations/${pathId(id)}`,
            body: input,
          })
          .then(unwrap),
    },
    orders: {
      list: (params?: ListParams) =>
        t.request<Page<Order>>({ method: 'GET', path: '/orders', query: params }),
      get: (id: string) =>
        t
          .request<{ data: OrderWithItems }>({ method: 'GET', path: `/orders/${pathId(id)}` })
          .then(unwrap),
    },
    customers: {
      list: (params?: ListParams & { q?: string }) =>
        t.request<Page<Customer>>({ method: 'GET', path: '/customers', query: params }),
      get: (id: string) =>
        t
          .request<{ data: Customer }>({ method: 'GET', path: `/customers/${pathId(id)}` })
          .then(unwrap),
    },
  }
}

export function createClient(options: MarcaponyClientOptions): MarcaponyClient {
  const t = new Transport(options)
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const verify = options.appId
    ? createIdentityVerifier({
        appId: options.appId,
        baseUrl,
        fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      })
    : null

  return {
    identity: async (request: Request): Promise<Identity | null> => {
      if (!verify) {
        throw new Error(
          'marcapony-sdk: identity() needs the app id. Pass appId: env.MARCAPONY_APP_ID to createClient.',
        )
      }
      return verify(request.headers.get(IDENTITY_HEADER))
    },
    forRequest: (request: Request): ScopedClient => {
      const token = request.headers.get(IDENTITY_HEADER)
      if (!token) {
        throw new UnauthorizedError(
          401,
          'invalid_identity',
          'forRequest: this request carries no signed-in user. Answer 401 or send the visitor to sign in.',
        )
      }
      const scoped = new Transport(options, { [IDENTITY_HEADER]: token })
      return { me: meClient(scoped), ...memberClient(scoped) }
    },
    site: {
      get: () => t.request<{ data: SiteInfo }>({ method: 'GET', path: '/site' }).then(unwrap),
    },
    regions: {
      list: () => t.request<{ data: Country[] }>({ method: 'GET', path: '/regions' }).then(unwrap),
    },
    products: {
      list: (params?: ListParams & { category?: string }) =>
        t.request<Page<Product>>({ method: 'GET', path: '/products', query: params }),
      get: (id: string) =>
        t.request<{ data: Product }>({ method: 'GET', path: `/products/${id}` }).then(unwrap),
    },
    categories: {
      list: () =>
        t.request<{ data: Category[] }>({ method: 'GET', path: '/categories' }).then(unwrap),
    },
    highlightedProducts: {
      list: (params?: ListParams) =>
        t
          .request<{ data: HighlightedProduct[] }>({
            method: 'GET',
            path: '/highlighted-products',
            query: params,
          })
          .then(unwrap),
    },
    customers: {
      list: (params?: ListParams & { q?: string }) =>
        t.request<Page<Customer>>({ method: 'GET', path: '/customers', query: params }),
      get: (id: string) =>
        t.request<{ data: Customer }>({ method: 'GET', path: `/customers/${id}` }).then(unwrap),
      create: (input: CreateCustomerInput, options?: RequestOptions) =>
        t
          .request<{ data: Customer }>({
            method: 'POST',
            path: '/customers',
            body: input,
            idempotencyKey: options?.idempotencyKey,
          })
          .then(unwrap),
    },
    reservations: {
      list: (params?: ListParams) =>
        t.request<Page<Reservation>>({ method: 'GET', path: '/reservations', query: params }),
      get: (id: string) =>
        t
          .request<{ data: Reservation }>({ method: 'GET', path: `/reservations/${id}` })
          .then(unwrap),
      create: (input: CreateReservationInput, options?: RequestOptions) =>
        t
          .request<{ data: unknown }>({
            method: 'POST',
            path: '/reservations',
            body: input,
            idempotencyKey: options?.idempotencyKey,
          })
          .then(unwrap),
      updateStatus: (id: string, input: UpdateReservationStatusInput) =>
        t
          .request<{ data: unknown }>({
            method: 'PATCH',
            path: `/reservations/${id}`,
            body: input,
          })
          .then(unwrap),
    },
    availabilityBlocks: {
      list: () =>
        t
          .request<{ data: AvailabilityBlock[] }>({ method: 'GET', path: '/availability-blocks' })
          .then(unwrap),
    },
    orders: {
      list: (params?: ListParams) =>
        t.request<Page<Order>>({ method: 'GET', path: '/orders', query: params }),
      get: (id: string) =>
        t.request<{ data: OrderWithItems }>({ method: 'GET', path: `/orders/${id}` }).then(unwrap),
      create: (input: CreateOrderInput, options?: RequestOptions) =>
        t
          .request<{ data: unknown }>({
            method: 'POST',
            path: '/orders',
            body: input,
            idempotencyKey: options?.idempotencyKey,
          })
          .then(unwrap),
    },
    paymentLinks: {
      list: (params?: ListParams) =>
        t.request<Page<PaymentLink>>({ method: 'GET', path: '/payment-links', query: params }),
      get: (id: string) =>
        t
          .request<{ data: PaymentLink }>({ method: 'GET', path: `/payment-links/${id}` })
          .then(unwrap),
      create: (input: CreatePaymentLinkInput, options?: RequestOptions) =>
        t
          .request<{ data: unknown }>({
            method: 'POST',
            path: '/payment-links',
            body: input,
            idempotencyKey: options?.idempotencyKey,
          })
          .then(unwrap),
    },
    discounts: {
      list: (params?: ListParams) =>
        t.request<Page<Discount>>({ method: 'GET', path: '/discounts', query: params }),
    },
    formSubmissions: {
      list: (params?: ListParams) =>
        t.request<Page<FormSubmission>>({
          method: 'GET',
          path: '/form-submissions',
          query: params,
        }),
      create: (input: SubmitFormInput, options?: RequestOptions) =>
        t
          .request<{ data: unknown }>({
            method: 'POST',
            path: '/form-submissions',
            body: input,
            idempotencyKey: options?.idempotencyKey,
          })
          .then(unwrap),
    },
    posts: {
      list: (params?: ListParams & ListPostsFilters) =>
        t.request<Page<Post>>({ method: 'GET', path: '/posts', query: params }),
      get: (id: string) =>
        t.request<{ data: Post }>({ method: 'GET', path: `/posts/${id}` }).then(unwrap),
      create: (input: CreatePostInput, options?: RequestOptions) =>
        t
          .request<{ data: Post }>({
            method: 'POST',
            path: '/posts',
            body: input,
            idempotencyKey: options?.idempotencyKey,
          })
          .then(unwrap),
      update: (id: string, input: UpdatePostInput) =>
        t
          .request<{ data: Post }>({ method: 'PATCH', path: `/posts/${id}`, body: input })
          .then(unwrap),
      publish: (id: string) =>
        t.request<{ data: Post }>({ method: 'POST', path: `/posts/${id}/publish` }).then(unwrap),
      unpublish: (id: string) =>
        t.request<{ data: Post }>({ method: 'POST', path: `/posts/${id}/unpublish` }).then(unwrap),
      delete: (id: string, params?: { deleteTranslations?: boolean }) =>
        t
          .request<{ data: unknown }>({ method: 'DELETE', path: `/posts/${id}`, query: params })
          .then(unwrap),
      getTranslation: (id: string, locale: string) =>
        t
          .request<{ data: Post }>({ method: 'GET', path: `/posts/${id}/translations/${locale}` })
          .then(unwrap),
      createTranslation: (
        id: string,
        input: CreatePostTranslationInput,
        options?: RequestOptions,
      ) =>
        t
          .request<{ data: Post }>({
            method: 'POST',
            path: `/posts/${id}/translations`,
            body: input,
            idempotencyKey: options?.idempotencyKey,
          })
          .then(unwrap),
    },
    blogAuthors: {
      list: (params?: ListBlogAuthorsFilters) =>
        t
          .request<{ data: BlogAuthor[] }>({ method: 'GET', path: '/blog-authors', query: params })
          .then(unwrap),
      get: (id: string) =>
        t
          .request<{ data: BlogAuthor }>({ method: 'GET', path: `/blog-authors/${id}` })
          .then(unwrap),
      create: (input: CreateBlogAuthorInput, options?: RequestOptions) =>
        t
          .request<{ data: BlogAuthor }>({
            method: 'POST',
            path: '/blog-authors',
            body: input,
            idempotencyKey: options?.idempotencyKey,
          })
          .then(unwrap),
      update: (id: string, input: UpdateBlogAuthorInput) =>
        t
          .request<{ data: BlogAuthor }>({
            method: 'PATCH',
            path: `/blog-authors/${id}`,
            body: input,
          })
          .then(unwrap),
      delete: (id: string) =>
        t
          .request<{ data: unknown }>({ method: 'DELETE', path: `/blog-authors/${id}` })
          .then(unwrap),
    },
    blogCategories: {
      list: (params?: { locale?: string }) =>
        t
          .request<{ data: BlogCategory[] }>({
            method: 'GET',
            path: '/blog-categories',
            query: params,
          })
          .then(unwrap),
      get: (id: string, params?: { locale?: string }) =>
        t
          .request<{ data: BlogCategory }>({
            method: 'GET',
            path: `/blog-categories/${id}`,
            query: params,
          })
          .then(unwrap),
      create: (input: CreateBlogCategoryInput, options?: RequestOptions) =>
        t
          .request<{ data: BlogCategory }>({
            method: 'POST',
            path: '/blog-categories',
            body: input,
            idempotencyKey: options?.idempotencyKey,
          })
          .then(unwrap),
      update: (id: string, input: UpdateBlogCategoryInput) =>
        t
          .request<{ data: BlogCategory }>({
            method: 'PATCH',
            path: `/blog-categories/${id}`,
            body: input,
          })
          .then(unwrap),
      createTranslation: (
        id: string,
        input: CreateBlogCategoryTranslationInput,
        options?: RequestOptions,
      ) =>
        t
          .request<{ data: BlogCategory }>({
            method: 'POST',
            path: `/blog-categories/${id}/translation`,
            body: input,
            idempotencyKey: options?.idempotencyKey,
          })
          .then(unwrap),
      delete: (id: string) =>
        t
          .request<{ data: unknown }>({ method: 'DELETE', path: `/blog-categories/${id}` })
          .then(unwrap),
    },
    media: {
      list: (params?: ListParams & { q?: string; fileType?: AssetFileType }) =>
        t.request<Page<Asset>>({ method: 'GET', path: '/media', query: params }),
      get: (id: string) =>
        t.request<{ data: Asset }>({ method: 'GET', path: `/media/${id}` }).then(unwrap),
      upload: (input: ImportAssetInput, options?: RequestOptions) =>
        t
          .request<{ data: Asset }>({
            method: 'POST',
            path: '/media',
            body: input,
            idempotencyKey: options?.idempotencyKey,
          })
          .then(unwrap),
    },
  }
}

function unwrap<T>(envelope: { data: T } | null): T {
  // Every /ext/v1 success carries `{ data }`; a bodiless 2xx can only come from
  // something in front of the surface, and must not surface as a bare TypeError.
  if (envelope === null || typeof envelope !== 'object' || !('data' in envelope)) {
    throw new ServerError(200, 'server_error', 'Response did not carry a { data } envelope')
  }
  return envelope.data
}

export interface CreateOwnReservationInput {
  requestedDate: string
  requestedTime: string
  duration?: number
  notes?: string
  customFields?: { key: string; label: string; value: string }[]
}

/** The calls a signed-in visitor may make about themselves; the platform forces the customer. */
export type MeClient = {
  reservations: {
    list: (params?: ListParams) => Promise<Page<Reservation>>
    get: (id: string) => Promise<Reservation>
    create: (input: CreateOwnReservationInput, options?: RequestOptions) => Promise<Reservation>
    cancel: (id: string) => Promise<{ id: string; status: 'cancelled' }>
  }
  orders: {
    list: (params?: ListParams) => Promise<Page<Order>>
    get: (id: string) => Promise<OrderWithItems>
  }
}

/** What a team member's identity may call on the account (see `forRequest`). */
export type MemberClient = {
  reservations: {
    list: (params?: ListParams) => Promise<Page<Reservation>>
    get: (id: string) => Promise<Reservation>
    create: (input: CreateReservationInput, options?: RequestOptions) => Promise<unknown>
    updateStatus: (id: string, input: UpdateReservationStatusInput) => Promise<unknown>
  }
  orders: {
    list: (params?: ListParams) => Promise<Page<Order>>
    get: (id: string) => Promise<OrderWithItems>
  }
  customers: {
    list: (params?: ListParams & { q?: string }) => Promise<Page<Customer>>
    get: (id: string) => Promise<Customer>
  }
}

/**
 * A client acting as the signed-in person of one request. A customer (portal
 * visitor) uses `me`; a team member (member tool) uses the account groups.
 */
export type ScopedClient = { me: MeClient } & MemberClient

export type MarcaponyClient = {
  /** Who is signed in on this request, or null. For display; the platform enforces access. */
  identity: (request: Request) => Promise<Identity | null>
  /** A client that acts as the signed-in person of this request: `me` for a customer, the account groups for a team member. */
  forRequest: (request: Request) => ScopedClient
  site: { get: () => Promise<SiteInfo> }
  regions: { list: () => Promise<Country[]> }
  products: {
    list: (params?: ListParams & { category?: string }) => Promise<Page<Product>>
    get: (id: string) => Promise<Product>
  }
  categories: { list: () => Promise<Category[]> }
  highlightedProducts: { list: (params?: ListParams) => Promise<HighlightedProduct[]> }
  customers: {
    list: (params?: ListParams & { q?: string }) => Promise<Page<Customer>>
    get: (id: string) => Promise<Customer>
    create: (input: CreateCustomerInput, options?: RequestOptions) => Promise<Customer>
  }
  reservations: {
    list: (params?: ListParams) => Promise<Page<Reservation>>
    get: (id: string) => Promise<Reservation>
    create: (input: CreateReservationInput, options?: RequestOptions) => Promise<unknown>
    updateStatus: (id: string, input: UpdateReservationStatusInput) => Promise<unknown>
  }
  availabilityBlocks: { list: () => Promise<AvailabilityBlock[]> }
  orders: {
    list: (params?: ListParams) => Promise<Page<Order>>
    get: (id: string) => Promise<OrderWithItems>
    create: (input: CreateOrderInput, options?: RequestOptions) => Promise<unknown>
  }
  paymentLinks: {
    list: (params?: ListParams) => Promise<Page<PaymentLink>>
    get: (id: string) => Promise<PaymentLink>
    create: (input: CreatePaymentLinkInput, options?: RequestOptions) => Promise<unknown>
  }
  discounts: { list: (params?: ListParams) => Promise<Page<Discount>> }
  formSubmissions: {
    list: (params?: ListParams) => Promise<Page<FormSubmission>>
    create: (input: SubmitFormInput, options?: RequestOptions) => Promise<unknown>
  }
  posts: {
    list: (params?: ListParams & ListPostsFilters) => Promise<Page<Post>>
    get: (id: string) => Promise<Post>
    create: (input: CreatePostInput, options?: RequestOptions) => Promise<Post>
    update: (id: string, input: UpdatePostInput) => Promise<Post>
    publish: (id: string) => Promise<Post>
    unpublish: (id: string) => Promise<Post>
    delete: (id: string, params?: { deleteTranslations?: boolean }) => Promise<unknown>
    getTranslation: (id: string, locale: string) => Promise<Post>
    createTranslation: (
      id: string,
      input: CreatePostTranslationInput,
      options?: RequestOptions,
    ) => Promise<Post>
  }
  blogAuthors: {
    list: (params?: ListBlogAuthorsFilters) => Promise<BlogAuthor[]>
    get: (id: string) => Promise<BlogAuthor>
    create: (input: CreateBlogAuthorInput, options?: RequestOptions) => Promise<BlogAuthor>
    update: (id: string, input: UpdateBlogAuthorInput) => Promise<BlogAuthor>
    delete: (id: string) => Promise<unknown>
  }
  blogCategories: {
    list: (params?: { locale?: string }) => Promise<BlogCategory[]>
    get: (id: string, params?: { locale?: string }) => Promise<BlogCategory>
    create: (input: CreateBlogCategoryInput, options?: RequestOptions) => Promise<BlogCategory>
    update: (id: string, input: UpdateBlogCategoryInput) => Promise<BlogCategory>
    createTranslation: (
      id: string,
      input: CreateBlogCategoryTranslationInput,
      options?: RequestOptions,
    ) => Promise<BlogCategory>
    delete: (id: string) => Promise<unknown>
  }
  media: {
    list: (params?: ListParams & { q?: string; fileType?: AssetFileType }) => Promise<Page<Asset>>
    get: (id: string) => Promise<Asset>
    upload: (input: ImportAssetInput, options?: RequestOptions) => Promise<Asset>
  }
}
