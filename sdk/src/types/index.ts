/**
 * Public types for the Marcapony external API (/ext/v1).
 *
 * These mirror the API's frozen response views, not internal domain models.
 * They are hand-written on purpose, so the public contract cannot drift with
 * an internal refactor. Fields are added over the life of v1, never removed or
 * retyped.
 */

export * from './common.js'
export * from './site.js'
export * from './catalog.js'
export * from './customers.js'
export * from './reservations.js'
export * from './orders.js'
export * from './payments.js'
export * from './forms.js'
export * from './blog.js'
export * from './media.js'
export * from './me.js'
