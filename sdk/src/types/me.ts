import type { PaymentLinkStatus } from './payments.js'
import type { Reservation, ReservationStatus } from './reservations.js'

/** A reservation of the signed-in customer (`me.reservations`), with the deposit state. */
export interface OwnReservation extends Reservation {
  depositAmount: number | null
  depositCurrency: string | null
  depositStatus: 'pending' | 'paid' | 'refunded' | 'forfeited' | 'needs_refund' | 'released' | null
  depositRefundCutoffHours: number | null
  depositPaidAt: string | null
}

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

export interface CreateOwnReservationInput {
  requestedDate: string
  requestedTime: string
  duration?: number
  notes?: string
  customFields?: { key: string; label: string; value: string }[]
}
