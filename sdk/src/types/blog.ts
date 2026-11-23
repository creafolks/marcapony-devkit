import type { ListParams } from './common.js'

export interface PostAuthor {
  id: string | null
  slug: string | null
  displayName: string | null
  title: string | null
  avatarUrl: string | null
}

export interface PostCategory {
  id: string
  name: string
  slug: string
}

export type PostKind = 'article' | 'event'
export type PostRelationType = 'tags' | 'ids' | 'no-relation'

export interface Post {
  id: string
  title: string
  slug: string
  /** Sanitized HTML. Scripts, event handlers and iframes are stripped server-side. */
  content: string
  excerpt: string
  locale: string
  isPublished: boolean
  isFeatured: boolean
  publishedAt: string | null
  /** Asset id of the cover image, not a URL. Resolve it with `media.get`. */
  imageId: string | null
  imageUrl: string | null
  metaDescription: string | null
  tags: string[]
  author: PostAuthor | null
  categories: PostCategory[]
  /**
   * The TRANSLATION pointer: null on an original, the original post's id on a
   * translation. Related content is `relationType` + `relatedPostIds`, which
   * are a different mechanism entirely.
   */
  translationOfPostId: string | null
  relationType: PostRelationType
  relatedPostIds: string[]
  showReadingTime: boolean
  readingTime: number | null
  allowComments: boolean
  postKind: PostKind
  /**
   * Wall-clock local time at the venue: `YYYY-MM-DDTHH:mm(:ss)`, never with a
   * `Z` suffix and never with an offset. NOT an instant — do not pass it
   * through `new Date()` and re-serialize, and do not convert it between time
   * zones. The platform stores these as TIMESTAMP without a time zone because
   * a 20:00 concert must read as 20:00 everywhere.
   */
  eventStartAt: string | null
  eventEndAt: string | null
  eventLocation: string | null
  createdAt: string
  updatedAt: string
}

export interface CreatePostInput {
  title: string
  /** HTML. Sanitized server-side. */
  content: string
  /**
   * The URL slug, normalized like a generated one. Omitted on create, it comes
   * from the title. On update, a title change moves the slug only while the
   * post is unpublished; send `slug` to rename a published post. At most 200
   * characters. A slug already used in that language is a `ValidationError`
   * with `SLUG_TAKEN` on `slug`; one that normalizes to nothing (only
   * punctuation, for example) is a `ValidationError` with `SLUG_INVALID`.
   */
  slug?: string
  excerpt?: string
  metaDescription?: string
  /** Asset id. Obtain one with `media.list` or `media.upload`. */
  imageId?: string
  tags?: string[]
  isFeatured?: boolean
  authorId?: string | null
  categoryIds?: string[]
  relationType?: PostRelationType
  /** Required and non-empty when `relationType` is `'ids'`. */
  relatedPostIds?: string[]
  showReadingTime?: boolean
  allowComments?: boolean
  postKind?: PostKind
  /**
   * Wall-clock, no time zone. See `Post.eventStartAt`. `null` clears the
   * field, which is how an event goes back to being an article.
   */
  eventStartAt?: string | null
  eventEndAt?: string | null
  /** At most 200 characters. */
  eventLocation?: string | null
}

export type UpdatePostInput = Omit<CreatePostInput, 'imageId'> & {
  /** Asset id. `null` removes the cover image. */
  imageId?: string | null
}

export interface CreatePostTranslationInput {
  locale: string
  title: string
  content: string
  /** At most 500 characters. Generated from the content when omitted. */
  excerpt?: string
  metaDescription?: string
  tags?: string[]
  /** Asset id. Omitted, the translation uses the original post's cover image. */
  imageId?: string
  /** Omitted, the translation has no categories. */
  categoryIds?: string[]
  /**
   * Omitted, the translation keeps the original post's author; `null` leaves
   * it without one. An author of another account is a `ValidationError`.
   */
  authorId?: string | null
}

export type BlogAuthorSourceType = 'platform_user' | 'portal_customer'

export interface BlogAuthor {
  id: string
  slug: string
  displayName: string
  title: string | null
  bio: string | null
  avatarUrl: string | null
  socialLinks: Record<string, string>
  sourceType: BlogAuthorSourceType
  isActive: boolean
  /** Title and bio in each of the site's other languages, keyed by locale. */
  translations?: Record<string, { title: string | null; bio: string | null }>
  createdAt: string
  updatedAt: string
}

export interface CreateBlogAuthorInput {
  sourceType: BlogAuthorSourceType
  /** Unique per account together with `sourceType`. */
  sourceId: string
  slug: string
  displayName: string
  title?: string | null
  bio?: string | null
  avatarUrl?: string | null
  socialLinks?: Record<string, string>
  isActive?: boolean
  /**
   * Title and bio per locale. Only the locales sent are written; a locale with
   * both empty falls back to the base title and bio. An entry for the site's
   * default locale writes the base fields.
   */
  translations?: Record<string, { title?: string | null; bio?: string | null }>
}

/** `sourceType` and `sourceId` identify who the profile is for and cannot change. */
export type UpdateBlogAuthorInput = Partial<Omit<CreateBlogAuthorInput, 'sourceType' | 'sourceId'>>

export interface BlogCategory {
  id: string
  name: string
  slug: string
  description: string | null
  locale: string
  /** Same pattern posts use: null on an original, the original's id on a translation. */
  translationOfCategoryId: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateBlogCategoryInput {
  name: string
  /** Derived from the name when omitted. */
  slug?: string
  description?: string
  locale?: string
  status?: 'active' | 'archived'
  sortOrder?: number
}

export type UpdateBlogCategoryInput = Omit<Partial<CreateBlogCategoryInput>, 'description'> & {
  /** `null` clears the description. */
  description?: string | null
}

export interface CreateBlogCategoryTranslationInput {
  locale: string
  name: string
  slug?: string
  description?: string
}

export interface ListPostsFilters {
  /** Strings, not booleans: the surface takes them as query values. */
  published?: 'true' | 'false'
  featured?: 'true' | 'false'
  locale?: string
  categoryId?: string
  kind?: PostKind
  q?: string
}

/** `posts.list` parameters: pagination plus the post filters. */
export type ListPostsParams = ListParams & ListPostsFilters

export interface ListBlogAuthorsFilters {
  page?: number
  limit?: number
  query?: string
  sourceType?: BlogAuthorSourceType
  isActive?: boolean
}
