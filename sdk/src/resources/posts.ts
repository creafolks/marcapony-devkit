import { path } from '../path.js'
import { create, get, list, remove, update, type Transport } from '../transport.js'
import type {
  CreatePostInput,
  CreatePostTranslationInput,
  ListPostsParams,
  Page,
  Post,
  RequestOptions,
  UpdatePostInput,
} from '../types/index.js'

export function postsResource(t: Transport) {
  return {
    /** One page of blog posts and events, filtered by the given fields. */
    list: (params?: ListPostsParams): Promise<Page<Post>> => list(t, path`/posts`, params),
    /** One post by id. */
    get: (id: string): Promise<Post> => get(t, path`/posts/${id}`),
    /** Creates an unpublished post; publish it with `publish`. */
    create: (input: CreatePostInput, options?: RequestOptions): Promise<Post> =>
      create(t, path`/posts`, input, options),
    /** Updates a post. */
    update: (id: string, input: UpdatePostInput): Promise<Post> =>
      update(t, path`/posts/${id}`, input),
    /** Publishes a post on the live site. */
    publish: (id: string): Promise<Post> => create(t, path`/posts/${id}/publish`),
    /** Takes a post off the live site. */
    unpublish: (id: string): Promise<Post> => create(t, path`/posts/${id}/unpublish`),
    /** Deletes a post; `deleteTranslations: true` also deletes its translations. */
    delete: (id: string, params?: { deleteTranslations?: boolean }): Promise<unknown> =>
      remove(t, path`/posts/${id}`, params),
    /** The translation of a post in one locale. */
    getTranslation: (id: string, locale: string): Promise<Post> =>
      get(t, path`/posts/${id}/translations/${locale}`),
    /** Creates a translation of a post; it is its own post with its own id. */
    createTranslation: (
      id: string,
      input: CreatePostTranslationInput,
      options?: RequestOptions,
    ): Promise<Post> => create(t, path`/posts/${id}/translations`, input, options),
  }
}

export type PostsResource = ReturnType<typeof postsResource>
