import { UnauthorizedError } from './errors.js'
import { createIdentityVerifier, IDENTITY_HEADER, type Identity } from './identity.js'
import { resolveOptions, type MarcaponyClientOptions } from './options.js'
import { Transport } from './transport.js'
import { blogAuthorsResource, type BlogAuthorsResource } from './resources/blog-authors.js'
import { blogCategoriesResource, type BlogCategoriesResource } from './resources/blog-categories.js'
import {
  categoriesResource,
  highlightedProductsResource,
  productsResource,
  type CategoriesResource,
  type HighlightedProductsResource,
  type ProductsResource,
} from './resources/catalog.js'
import { customersResource, type CustomersResource } from './resources/customers.js'
import {
  formSubmissionsResource,
  type FormSubmissionsResource,
} from './resources/form-submissions.js'
import { meResource, type MeClient } from './resources/me.js'
import { mediaResource, type MediaResource } from './resources/media.js'
import { memberClient, type MemberClient } from './resources/member.js'
import { ordersResource, type OrdersResource } from './resources/orders.js'
import {
  discountsResource,
  paymentLinksResource,
  type DiscountsResource,
  type PaymentLinksResource,
} from './resources/payments.js'
import { postsResource, type PostsResource } from './resources/posts.js'
import {
  availabilityBlocksResource,
  reservationsResource,
  type AvailabilityBlocksResource,
  type ReservationsResource,
} from './resources/reservations.js'
import {
  regionsResource,
  siteResource,
  type RegionsResource,
  type SiteResource,
} from './resources/site.js'

/**
 * A client acting as the signed-in person of one request. A customer (portal
 * visitor) uses `me`; a team member (member tool) uses the account groups.
 * Which one applies is fixed by the app: a customer-facing app only ever gets
 * customer identities and a team tool only member identities.
 *
 * Create it per request and never keep it, or anything it returned, in module
 * scope: a worker isolate serves many people, and a cached answer would be
 * shown to the next one.
 */
export type ScopedClient = {
  /** The identity's kind, read from the token without verifying it (the platform verifies every call). */
  kind: 'customer' | 'member' | null
  me: MeClient
} & MemberClient

export interface MarcaponyClient {
  /** Who is signed in on this request, or null. For display; the platform enforces access. */
  identity: (request: Request) => Promise<Identity | null>
  /** A client that acts as the signed-in person of this request: `me` for a customer, the account groups for a team member. */
  forRequest: (request: Request) => ScopedClient
  site: SiteResource
  regions: RegionsResource
  products: ProductsResource
  categories: CategoriesResource
  highlightedProducts: HighlightedProductsResource
  customers: CustomersResource
  reservations: ReservationsResource
  availabilityBlocks: AvailabilityBlocksResource
  orders: OrdersResource
  paymentLinks: PaymentLinksResource
  discounts: DiscountsResource
  formSubmissions: FormSubmissionsResource
  posts: PostsResource
  blogAuthors: BlogAuthorsResource
  blogCategories: BlogCategoriesResource
  media: MediaResource
}

/** Creates a client for the external API. Use it from server code only. */
export function createClient(options: MarcaponyClientOptions): MarcaponyClient {
  const resolved = resolveOptions(options)
  const t = new Transport(resolved)
  const verify = resolved.appId
    ? createIdentityVerifier({
        appId: resolved.appId,
        baseUrl: resolved.baseUrl,
        fetch: resolved.fetch,
      })
    : null

  return {
    identity: async (request) => {
      if (!verify) {
        throw new Error(
          'marcapony-sdk: identity() needs the app id. Pass appId: env.MARCAPONY_APP_ID to createClient.',
        )
      }
      return verify(request.headers.get(IDENTITY_HEADER))
    },
    forRequest: (request) => {
      const token = request.headers.get(IDENTITY_HEADER)
      if (!token) {
        throw new UnauthorizedError(
          401,
          'invalid_identity',
          'forRequest: this request carries no signed-in user. Answer 401 or send the visitor to sign in.',
        )
      }
      const scoped = t.withHeaders({ [IDENTITY_HEADER]: token })
      return { kind: unverifiedKind(token), me: meResource(scoped), ...memberClient(scoped) }
    },
    site: siteResource(t),
    regions: regionsResource(t),
    products: productsResource(t),
    categories: categoriesResource(t),
    highlightedProducts: highlightedProductsResource(t),
    customers: customersResource(t),
    reservations: reservationsResource(t),
    availabilityBlocks: availabilityBlocksResource(t),
    orders: ordersResource(t),
    paymentLinks: paymentLinksResource(t),
    discounts: discountsResource(t),
    formSubmissions: formSubmissionsResource(t),
    posts: postsResource(t),
    blogAuthors: blogAuthorsResource(t),
    blogCategories: blogCategoriesResource(t),
    media: mediaResource(t),
  }
}

/**
 * The `kind` claim of an identity token, read WITHOUT verifying it: a hint for
 * which half of the scoped client applies. The platform verifies every call and
 * refuses the wrong kind, so a forged value only gets the caller 401s.
 */
function unverifiedKind(token: string): 'customer' | 'member' | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    const kind = (JSON.parse(json) as { kind?: unknown }).kind
    return kind === 'customer' || kind === 'member' ? kind : null
  } catch {
    return null
  }
}
