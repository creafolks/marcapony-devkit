export interface Product {
  id: string
  name: string
  slug: string
  status: number
  description: string
  categoryId: string | null
  categoryName: string | null
  categorySlug: string | null
  price: number | null
  salePrice: number | null
  currency: string | null
  stock: number | null
  trackStock: boolean
  requiresShipping: boolean
  imageIds: string[]
  coverImageId: string | null
  createdAt: string
  updatedAt: string
}

export interface Category {
  id: string
  name: string
  slug: string
  description: string | null
  parentId: string | null
  productsCount: number
}

export interface HighlightedProduct {
  id: string
  productId: string
  categoryId: string | null
  highlightOrder: number
  product: Record<string, unknown> | null
}
