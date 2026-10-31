import { path } from '../path.js'
import { create, get, list, type Transport } from '../transport.js'
import type {
  CreatedOrder,
  CreateOrderInput,
  ListParams,
  Order,
  OrderWithItems,
  Page,
  RequestOptions,
  WriteResult,
} from '../types/index.js'

export function ordersResource(t: Transport) {
  return {
    /** One page of orders. */
    list: (params?: ListParams): Promise<Page<Order>> => list(t, path`/orders`, params),
    /** One order with its line items. */
    get: (id: string): Promise<OrderWithItems> => get(t, path`/orders/${id}`),
    /** Creates an order from catalog items; costs are computed on the server. */
    create: (input: CreateOrderInput, options?: RequestOptions): Promise<WriteResult<CreatedOrder>> =>
      create(t, path`/orders`, input, options),
  }
}

export type OrdersResource = ReturnType<typeof ordersResource>
