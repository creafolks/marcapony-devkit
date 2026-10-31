export interface Reservation {
  id: string
  customerId: string | null
  requestedDate: string
  requestedTime: string
  duration: number | null
  status: string | number
  notes: string | null
  orderId: string | null
  approvedAt: string | null
  rejectedAt: string | null
  createdAt: string | null
  updatedAt: string | null
  customerName: string | null
  customerEmail: string | null
  customerPhone: string | null
  productName: string | null
}

export type ReservationStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'completed'

export interface AvailabilityBlock {
  id: string
  blockType: string
  title: string | null
  startDate: string
  endDate: string | null
  startTime: string
  endTime: string
  isFullDay: boolean
  recurrenceDays: number[] | null
  createdAt: string
}

export interface CreateReservationInput {
  customerId?: string
  customerName: string
  customerEmail: string
  customerPhone?: string
  /** YYYY-MM-DD */
  requestedDate: string
  /** HH:mm */
  requestedTime: string
  /** Minutes, 15–480 */
  duration?: number
  notes?: string
  customFields?: Array<{ key: string; label: string; value: string }>
  /**
   * 'slots' (default) books on the account's availability grid — the time
   * must be a generated slot inside working hours. 'free' books an arbitrary
   * wall-clock time (a transfer leaves when the flight lands, not on a
   * 15-minute grid); the merchant's availability blocks and busy calendar
   * events still apply.
   */
  timeMode?: 'slots' | 'free'
  /**
   * 'single' (default) rejects a second booking overlapping the same time.
   * 'unlimited' allows simultaneous bookings (five cars can leave at 14:30).
   */
  capacityMode?: 'single' | 'unlimited'
}

export interface UpdateReservationStatusInput {
  status: 'approved' | 'rejected' | 'cancelled' | 'completed'
  rejectionReason?: string
}
