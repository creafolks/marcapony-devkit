import { path } from '../path.js'
import { create, get, list, remove, replace, update, type Transport } from '../transport.js'
import type {
  Category,
  CreateProductInput,
  HighlightedProduct,
  ListParams,
  ListProductsParams,
  Page,
  Product,
  ProductVariant,
  ProductVariantInput,
  RequestOptions,
  UpdateProductInput,
  VariantType,
} from '../types/index.js'

export function productsResource(t: Transport) {
  return {
    /**
     * One page of products. Published products only, unless the app manages
     * products (data access "account" and the `products:write` scope).
     */
    list: (params?: ListProductsParams): Promise<Page<Product>> => list(t, path`/products`, params),
    /** One product by id. A draft is a 404 unless the app manages products. */
    get: (id: string): Promise<Product> => get(t, path`/products/${id}`),
    /** Creates a draft product in the account's default language; publish it with `publish`. */
    create: (input: CreateProductInput, options?: RequestOptions): Promise<Product> =>
      create(t, path`/products`, input, options),
    /** Updates a product. Fields you leave out keep their value. */
    update: (id: string, input: UpdateProductInput): Promise<Product> =>
      update(t, path`/products/${id}`, input),
    /** Puts a product (every language of it) on the live site. */
    publish: (id: string): Promise<Product> => create(t, path`/products/${id}/publish`),
    /** Takes a product off the live site; it becomes a draft again. */
    unpublish: (id: string): Promise<Product> => create(t, path`/products/${id}/unpublish`),
    /** Deletes a product with its translations and variants. */
    delete: (id: string): Promise<void> => remove(t, path`/products/${id}`),
    /** The variant combinations of a product. Needs the variants plugin. */
    variants: (id: string): Promise<ProductVariant[]> => get(t, path`/products/${id}/variants`),
    /**
     * Replaces the whole set of combinations: one left out is deleted (or
     * retired when orders name it). Send the list from `variants` with your
     * change applied. Needs the variants plugin.
     */
    setVariants: (
      id: string,
      input: { combinations: ProductVariantInput[] },
    ): Promise<ProductVariant[]> => replace(t, path`/products/${id}/variants`, input),
  }
}

export function variantTypesResource(t: Transport) {
  return {
    /** The account's variant axes and their values. Needs the variants plugin. */
    list: (): Promise<VariantType[]> => get(t, path`/variant-types`),
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
export type VariantTypesResource = ReturnType<typeof variantTypesResource>
export type CategoriesResource = ReturnType<typeof categoriesResource>
export type HighlightedProductsResource = ReturnType<typeof highlightedProductsResource>
