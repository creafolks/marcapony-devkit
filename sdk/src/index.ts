export { createClient, type MarcaponyClient, type ScopedClient } from './client.js'
export type { MarcaponyClientOptions } from './options.js'
export type { MeClient } from './resources/me.js'
export type { MemberClient } from './resources/member.js'
export type { BlogAuthorsResource } from './resources/blog-authors.js'
export type { BlogCategoriesResource } from './resources/blog-categories.js'
export type {
  CategoriesResource,
  HighlightedProductsResource,
  ProductsResource,
} from './resources/catalog.js'
export type { CustomersResource } from './resources/customers.js'
export type { FormSubmissionsResource } from './resources/form-submissions.js'
export type { MediaResource } from './resources/media.js'
export type { OrdersResource } from './resources/orders.js'
export type { DiscountsResource, PaymentLinksResource } from './resources/payments.js'
export type { PostsResource } from './resources/posts.js'
export type {
  AvailabilityBlocksResource,
  ReservationsResource,
} from './resources/reservations.js'
export type { RegionsResource, SiteResource } from './resources/site.js'
export * from './errors.js'
export { IDENTITY_HEADER, type Identity } from './identity.js'
export * from './types/index.js'
