import { path } from '../path.js'
import { create, get, list, update, type Transport } from '../transport.js'
import type {
  CreateOwnReservationInput,
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
  }
}

/**
 * The calls a signed-in customer may make about themselves. The platform takes
 * the customer from the verified identity on every call; nothing here can name
 * another customer, and another customer's id answers 404.
 */
export type MeClient = ReturnType<typeof meResource>
