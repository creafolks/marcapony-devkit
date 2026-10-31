export interface Customer {
  id: string
  name: string
  email: string
  phone: string | null
  address: string | null
  orderCount: number
  totalSpent: number
  status: number
  createdAt: string
  updatedAt: string
}

export interface CreateCustomerInput {
  name: string
  email: string
  phone?: string
  address?: string
}
