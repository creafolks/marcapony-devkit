import { path } from '../path.js'
import { get, list, type Transport } from '../transport.js'
import type { Category, HighlightedProduct, ListParams, Page, Product } from '../types/index.js'

export function productsResource(t: Transport) {
  return {
    /** One page of products, optionally narrowed to a category slug. */
    list: (params?: ListParams & { category?: string }): Promise<Page<Product>> =>
      list(t, path`/products`, params),
    /** One product by id. */
    get: (id: string): Promise<Product> => get(t, path`/products/${id}`),
  }
}

export function categoriesResource(t: Transport) {
  return {
    /** Every product category. */
    list: (): Promise<Category[]> => get(t, path`/categories`),
  }
}

export function highlightedProductsResource(t: Transport) {
  return {
    /** The products the account features, in their display order. */
    list: (params?: ListParams): Promise<HighlightedProduct[]> =>
      get(t, path`/highlighted-products`, params),
  }
}

export type ProductsResource = ReturnType<typeof productsResource>
export type CategoriesResource = ReturnType<typeof categoriesResource>
export type HighlightedProductsResource = ReturnType<typeof highlightedProductsResource>
