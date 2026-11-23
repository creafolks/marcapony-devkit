/** `status` of a product: a draft, on the site, or archived. */
export const ProductStatus = { Draft: 1, Published: 2, Archived: 3 } as const
export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus]

/** Where a product was created. */
export type ProductCreatedVia =
  | 'dashboard'
  | 'marco'
  | 'mcp'
  | 'sdk'
  | 'rpc'
  | 'automation'
  | 'import'
  | 'site_build'
  | 'super'
  | 'portal'

export interface Product {
  id: string
  name: string
  slug: string
  status: number
  sku: string | null
  tags: string[]
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
  /**
   * Where the product was created, the customer who created it and the app it
   * came through. Only present for an app that manages products (data access
   * "account" and the `products:write` scope).
   */
  createdVia?: ProductCreatedVia
  createdByCustomerId?: string | null
  createdByAppId?: string | null
  createdAt: string
  updatedAt: string
}

export interface ListProductsParams {
  page?: number
  perPage?: number
  /** A category slug; its subcategories are included. */
  category?: string
  categoryId?: string
  search?: string
  /** Defaults to the account's default language. Each language of a product is its own row. */
  locale?: string
  stockStatus?: 'in_stock' | 'low_stock' | 'out_of_stock'
  /**
   * The next three only for an app that manages products (an `account` app
   * with `products:write`, or a team member with the `products.write` grant);
   * any other app gets 403 `permission_denied`. Without `status` such an app
   * lists every status.
   */
  status?: ProductStatus
  createdVia?: ProductCreatedVia
  createdByCustomerId?: string
}

export interface CreateProductInput {
  name: string
  slug?: string
  /** HTML. */
  description?: string
  details?: { title: string; value: string }[]
  price?: number
  salePrice?: number
  currency?: string | null
  categoryId?: string | null
  sku?: string | null
  brand?: string | null
  gtin?: string | null
  mpn?: string | null
  condition?: 'new' | 'used' | 'refurbished'
  stock?: number
  trackStock?: boolean
  lowStockThreshold?: number | null
  requiresShipping?: boolean
  weight?: number
  dimensions?: { width?: number; height?: number; length?: number } | null
  /** Asset ids from the media library, not URLs. */
  imageIds?: string[]
  coverImageId?: string | null
  assetIds?: string[]
  tags?: string[]
  attributes?: Record<string, unknown>
  metaDescription?: string | null
  displayOrder?: number
  /** `buy`: the product can be added to the cart; `contact`: visitors ask about it. */
  ctaMode?: 'buy' | 'contact'
}

/** Every field optional: a field you leave out keeps its value. Send `[]` to clear a list. */
export type UpdateProductInput = Partial<CreateProductInput>

/** One purchasable combination of a product. `typeIds[i]` is the axis of `valueIds[i]`. */
export interface ProductVariant {
  id: string
  valueIds: string[]
  typeIds: string[]
  price: number | null
  stock: number | null
  sku: string | null
  imageId: string | null
  isDefault: boolean
  isActive: boolean
}

/**
 * A combination is identified by its set of `valueIds`: changing its price,
 * stock or sku keeps its id and order history; changing its values makes a
 * new combination.
 */
export interface ProductVariantInput {
  /** One value id per axis, from `variantTypes.list()`. */
  valueIds: string[]
  price?: number | null
  stock?: number | null
  sku?: string | null
  imageId?: string | null
  isDefault?: boolean
  isActive?: boolean
}

/** A variant axis (size, colour…) and its values, in the account's default language. */
export interface VariantType {
  id: string
  code: string
  name: string
  values: { id: string; code: string; name: string; value: string | null }[]
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
