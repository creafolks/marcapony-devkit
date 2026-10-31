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
  /** Wall-clock, no time zone. See `Post.eventStartAt`. */
  eventStartAt?: string
  eventEndAt?: string
  eventLocation?: string
}

export type UpdatePostInput = CreatePostInput

export interface CreatePostTranslationInput {
  locale: string
  title: string
  content: string
  excerpt?: string
  metaDescription?: string
  tags?: string[]
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

export type UpdateBlogCategoryInput = Partial<CreateBlogCategoryInput>

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
