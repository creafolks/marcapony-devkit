export interface OrderItem {
  id: string
  productId: string
  productVariantId: string | null
  variantLabel: string | null
  productName: string
  quantity: number
  price: number
  totalPrice: number
  currency: string
  requiresShipping: boolean
}

export interface Order {
  id: string
  orderNumber: number | null
  customerId: string | null
  currency: string | null
  buyerName: string | null
  buyerEmail: string | null
  buyerPhone: string | null
  source: string
  shippingAddress: Record<string, unknown> | null
  billingAddress: Record<string, unknown> | null
  totalAmount: number
  discountAmount: number
  shippingAmount: number
  taxAmount: number
  discountId: string | null
  status: number
  paymentStatus: number
  paymentMethod: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface OrderWithItems extends Order {
  items: OrderItem[]
}

export interface CreateOrderInput {
  /** Costs are derived from the catalog server-side; no client amounts. */
  items: Array<{ productId: string; productVariantId?: string; quantity: number }>
  discountCode?: string
  shippingAddress?: OrderAddressInput
  billingAddress?: OrderAddressInput
  notes?: string
}

export interface OrderAddressInput {
  address: string
  city: string
  country: string
  zipCode: string
  contactName?: string
}

/** What `orders.create` answers with; read the full order with `orders.get`. */
export interface CreatedOrder {
  id: string
  orderNumber: number | null
  status: number
  paymentStatus: number
  currency: string | null
  createdAt: string
}
