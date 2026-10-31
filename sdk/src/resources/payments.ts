import { path } from '../path.js'
import { create, get, list, type Transport } from '../transport.js'
import type {
  CreatePaymentLinkInput,
  Discount,
  ListParams,
  Page,
  PaymentLink,
  RequestOptions,
} from '../types/index.js'

export function paymentLinksResource(t: Transport) {
  return {
    /** One page of payment links. */
    list: (params?: ListParams): Promise<Page<PaymentLink>> =>
      list(t, path`/payment-links`, params),
    /** One payment link by id. */
    get: (id: string): Promise<PaymentLink> => get(t, path`/payment-links/${id}`),
    /** Creates a payment link for a free amount; optionally e-mails it to the customer. */
    create: (input: CreatePaymentLinkInput, options?: RequestOptions): Promise<unknown> =>
      create(t, path`/payment-links`, input, options),
  }
}

export function discountsResource(t: Transport) {
  return {
    /** One page of discounts and promotion codes. */
    list: (params?: ListParams): Promise<Page<Discount>> => list(t, path`/discounts`, params),
  }
}

export type PaymentLinksResource = ReturnType<typeof paymentLinksResource>
export type DiscountsResource = ReturnType<typeof discountsResource>
