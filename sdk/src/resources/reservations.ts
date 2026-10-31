import { path } from '../path.js'
import { create, get, list, update, type Transport } from '../transport.js'
import type {
  AvailabilityBlock,
  CreatedReservation,
  CreateReservationInput,
  ListParams,
  Page,
  RequestOptions,
  Reservation,
  ReservationStatusChange,
  UpdateReservationStatusInput,
} from '../types/index.js'

export function reservationsResource(t: Transport) {
  return {
    /** One page of the account's reservations. */
    list: (params?: ListParams): Promise<Page<Reservation>> =>
      list(t, path`/reservations`, params),
    /** One reservation by id. */
    get: (id: string): Promise<Reservation> => get(t, path`/reservations/${id}`),
    /** Books a reservation for a customer (created from name and e-mail when new). */
    create: (input: CreateReservationInput, options?: RequestOptions): Promise<CreatedReservation> =>
      create(t, path`/reservations`, input, options),
    /** Approves, rejects, cancels or completes a reservation. */
    updateStatus: (id: string, input: UpdateReservationStatusInput): Promise<ReservationStatusChange> =>
      update(t, path`/reservations/${id}`, input),
  }
}

export function availabilityBlocksResource(t: Transport) {
  return {
    /** The account's closed periods and blocked times. */
    list: (): Promise<AvailabilityBlock[]> => get(t, path`/availability-blocks`),
  }
}

export type ReservationsResource = ReturnType<typeof reservationsResource>
export type AvailabilityBlocksResource = ReturnType<typeof availabilityBlocksResource>
