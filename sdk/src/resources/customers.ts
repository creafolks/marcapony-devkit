import { path } from '../path.js'
import { create, get, list, type Transport } from '../transport.js'
import type {
  CreateCustomerInput,
  Customer,
  ListParams,
  Page,
  RequestOptions,
} from '../types/index.js'

export function customersResource(t: Transport) {
  return {
    /** One page of customers; `q` is a search term. */
    list: (params?: ListParams & { q?: string }): Promise<Page<Customer>> =>
      list(t, path`/customers`, params),
    /** One customer by id. */
    get: (id: string): Promise<Customer> => get(t, path`/customers/${id}`),
    /** Creates a customer, or returns the existing one with the same e-mail. */
    create: (input: CreateCustomerInput, options?: RequestOptions): Promise<Customer> =>
      create(t, path`/customers`, input, options),
  }
}

export type CustomersResource = ReturnType<typeof customersResource>
