export type PaymentLinkStatus = 'pending' | 'paid' | 'expired' | 'cancelled' | 'refunded'

export interface PaymentLinkLineItem {
  name: string
  price: number
  quantity: number
  productId?: string
  categoryId?: string
  variant?: string | null
}

export interface PaymentLink {
  id: string
  linkId: string
  customerId: string | null
  customerName: string | null
  customerEmail: string | null
  title: string
  description: string | null
  amount: number
  currency: string
  lineItems: PaymentLinkLineItem[]
  status: string
  expiresAt: string | null
  successUrl: string | null
  provider: string
  discountId: string | null
  discountAmount: number | null
  orderId: string | null
  createdAt: string
  updatedAt: string
  paidAt: string | null
  cancelledAt: string | null
}

export interface Discount {
  id: string
  name: string
  code: string | null
  discountType: string
  percentage: number | null
  fixedAmount: number | null
  currency: string | null
  startDate: string | null
  endDate: string | null
  maxUses: number | null
  usageCount: number
  minPurchaseAmount: number | null
  appliesTo: string
  targetIds: string[]
  status: number
  createdAt: string
  updatedAt: string
}

export interface CreatePaymentLinkInput {
  title: string
  description?: string
  amount: number
  currency?: string
  lineItems?: PaymentLinkLineItem[]
  /** ISO datetime */
  expiresAt?: string
  /** Must be on one of the account's verified domains (or a subdomain). */
  successUrl?: string
  installmentOptions?: number[]
  customerId?: string
  sendEmail?: boolean
  discountCode?: string
}
