import { path } from '../path.js'
import { create, get, remove, update, type Transport } from '../transport.js'
import type {
  BlogCategory,
  CreateBlogCategoryInput,
  CreateBlogCategoryTranslationInput,
  RequestOptions,
  UpdateBlogCategoryInput,
} from '../types/index.js'

export function blogCategoriesResource(t: Transport) {
  return {
    /** The account's blog categories, optionally in one locale. */
    list: (params?: { locale?: string }): Promise<BlogCategory[]> =>
      get(t, path`/blog-categories`, params),
    /** One blog category by id. */
    get: (id: string, params?: { locale?: string }): Promise<BlogCategory> =>
      get(t, path`/blog-categories/${id}`, params),
    /** Creates a blog category. */
    create: (input: CreateBlogCategoryInput, options?: RequestOptions): Promise<BlogCategory> =>
      create(t, path`/blog-categories`, input, options),
    /** Updates a blog category. */
    update: (id: string, input: UpdateBlogCategoryInput): Promise<BlogCategory> =>
      update(t, path`/blog-categories/${id}`, input),
    /** Creates the translation of a category in another locale. */
    createTranslation: (
      id: string,
      input: CreateBlogCategoryTranslationInput,
      options?: RequestOptions,
    ): Promise<BlogCategory> => create(t, path`/blog-categories/${id}/translation`, input, options),
    /** Deletes a blog category. */
    delete: (id: string): Promise<void> => remove(t, path`/blog-categories/${id}`),
  }
}

export type BlogCategoriesResource = ReturnType<typeof blogCategoriesResource>
