import type { Transport } from '../transport.js'
import {
  categoriesResource,
  productsResource,
  variantTypesResource,
  type CategoriesResource,
  type ProductsResource,
  type VariantTypesResource,
} from './catalog.js'
import { customersResource, type CustomersResource } from './customers.js'
import { ordersResource, type OrdersResource } from './orders.js'
import { reservationsResource, type ReservationsResource } from './reservations.js'

/** What a team member's identity may call on the account (see `forRequest`). */
export interface MemberClient {
  reservations: ReservationsResource
  orders: Pick<OrdersResource, 'list' | 'get'>
  customers: Pick<CustomersResource, 'list' | 'get'>
  /** Needs the `products.read` grant; writes and drafts need `products.write`. */
  products: ProductsResource
  categories: CategoriesResource
  variantTypes: VariantTypesResource
}

/**
 * The account routes a team member's identity reaches (a member tool opened
 * from the dashboard): the same calls as the plain client, minus the ones a
 * member tool cannot make. The platform intersects the key's scopes with the
 * member's grants and role on every call; a customer's identity gets 403
 * `scoped_route_required` here and must use `me`.
 */
export function memberClient(t: Transport): MemberClient {
  const orders = ordersResource(t)
  const customers = customersResource(t)
  return {
    reservations: reservationsResource(t),
    orders: { list: orders.list, get: orders.get },
    customers: { list: customers.list, get: customers.get },
    products: productsResource(t),
    categories: categoriesResource(t),
    variantTypes: variantTypesResource(t),
  }
}
