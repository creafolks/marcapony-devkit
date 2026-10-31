import { path } from '../path.js'
import { create, get, remove, update, type Transport } from '../transport.js'
import type {
  BlogAuthor,
  CreateBlogAuthorInput,
  ListBlogAuthorsFilters,
  RequestOptions,
  UpdateBlogAuthorInput,
} from '../types/index.js'

export function blogAuthorsResource(t: Transport) {
  return {
    /** The account's blog author profiles. */
    list: (params?: ListBlogAuthorsFilters): Promise<BlogAuthor[]> =>
      get(t, path`/blog-authors`, params),
    /** One author profile by id. */
    get: (id: string): Promise<BlogAuthor> => get(t, path`/blog-authors/${id}`),
    /** Creates an author profile for a team member or a portal customer. */
    create: (input: CreateBlogAuthorInput, options?: RequestOptions): Promise<BlogAuthor> =>
      create(t, path`/blog-authors`, input, options),
    /** Updates an author profile. */
    update: (id: string, input: UpdateBlogAuthorInput): Promise<BlogAuthor> =>
      update(t, path`/blog-authors/${id}`, input),
    /** Deletes an author profile. */
    delete: (id: string): Promise<unknown> => remove(t, path`/blog-authors/${id}`),
  }
}

export type BlogAuthorsResource = ReturnType<typeof blogAuthorsResource>
