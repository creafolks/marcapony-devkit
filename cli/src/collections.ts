/**
 * `collections` in `marcapony.json`: the records an app keeps. A customer
 * collection keeps them for each signed-in customer
 * (`mp.forRequest(request).me.records(name)` in the SDK); a shared one keeps
 * the app's own (`mp.records(name)`). Checked here with the platform's rules
 * so a mistake is reported before the build; the platform checks again on
 * deploy.
 */
export interface CollectionDeclaration {
  /** Lower case letters, digits and underscores, starting with a letter. */
  name: string
  /** `customer` (the default): one set of records per customer. `shared`: the app's own records. */
  scope?: CollectionScope
  /**
   * Who may read a record. On a customer collection `own`: the customer it
   * belongs to. On a shared one `public` (anyone the app serves) or
   * `signed_in` (a signed-in person of the app's audience).
   */
  read: 'own' | SharedReadRule
  /**
   * Who may write a record. On a customer collection `own`. On a shared one a
   * list of `feed` (an automation feed), `team` (a member of a team app) and
   * `server` (the app's key without a signed-in person). Customers never write
   * a shared collection.
   */
  write: 'own' | SharedWriter[]
  /**
   * Records one customer may hold in a customer collection, or the whole
   * collection holds when shared. 1 to 10,000; 1,000 when omitted.
   */
  maxRows?: number
  /** Top-level fields of `data` a list may filter and order by. At most 4. */
  indexes?: Array<{ field: string; type: CollectionIndexType }>
}

/**
 * A reference to a collection the account defines in the dashboard (Veriler):
 * data that belongs to the business, shared by every app and automation. The
 * app reads or writes it under `as` (or its own name) with `mp.records(name)`.
 * The platform checks on deploy that it exists, that the app's audience may
 * read it, and that a write was approved.
 */
export interface CollectionReference {
  name: string
  from: 'account'
  access: 'read' | 'write'
  /** The name the app code uses; defaults to `name`. */
  as?: string
}

export type CollectionEntry = CollectionDeclaration | CollectionReference

export const COLLECTION_SCOPES = ['customer', 'shared'] as const
export type CollectionScope = (typeof COLLECTION_SCOPES)[number]
export const SHARED_READ_RULES = ['public', 'signed_in'] as const
export type SharedReadRule = (typeof SHARED_READ_RULES)[number]
export const SHARED_WRITERS = ['feed', 'team', 'server'] as const
export type SharedWriter = (typeof SHARED_WRITERS)[number]

export const COLLECTION_INDEX_TYPES = ['string', 'number', 'date', 'boolean'] as const
export type CollectionIndexType = (typeof COLLECTION_INDEX_TYPES)[number]

export const MAX_COLLECTIONS = 16
export const MAX_COLLECTION_INDEXES = 4
export const MAX_COLLECTION_ROWS = 10_000

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,47}$/
const COLLECTION_KEYS = ['name', 'scope', 'read', 'write', 'maxRows', 'indexes']
const REFERENCE_KEYS = ['name', 'from', 'access', 'as']

const isReference = (value: Record<string, unknown>): boolean => 'from' in value
const INDEX_KEYS = ['field', 'type']

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function unknownKeys(value: Record<string, unknown>, known: string[]): string[] {
  return Object.keys(value).filter((key) => !known.includes(key))
}

function indexProblems(indexes: unknown, at: string): string[] {
  if (indexes === undefined) return []
  if (!Array.isArray(indexes)) return [`${at}.indexes must be a list`]
  const problems: string[] = []
  if (indexes.length > MAX_COLLECTION_INDEXES) {
    problems.push(`${at}.indexes has more than ${MAX_COLLECTION_INDEXES} entries`)
  }
  const fields = new Set<string>()
  indexes.forEach((index: unknown, i) => {
    const here = `${at}.indexes[${i}]`
    if (!isObject(index)) {
      problems.push(`${here} must be an object with field and type`)
      return
    }
    for (const key of unknownKeys(index, INDEX_KEYS)) {
      problems.push(`${here}.${key} is not a known field`)
    }
    if (typeof index.field !== 'string' || !FIELD_PATTERN.test(index.field)) {
      problems.push(
        `${here}.field must be a top-level key of the record: letters, digits and underscores, starting with a letter`,
      )
    } else if (fields.has(index.field)) {
      problems.push(`${here}.field "${index.field}" is duplicated`)
    } else {
      fields.add(index.field)
    }
    if (!COLLECTION_INDEX_TYPES.includes(index.type as CollectionIndexType)) {
      problems.push(`${here}.type must be one of ${COLLECTION_INDEX_TYPES.join(', ')}`)
    }
  })
  return problems
}

function accessProblems(collection: Record<string, unknown>, at: string): string[] {
  const { scope = 'customer', read, write } = collection
  if (!COLLECTION_SCOPES.includes(scope as CollectionScope)) {
    return [`${at}.scope must be "customer" or "shared"`]
  }
  if (scope === 'customer') {
    const problems: string[] = []
    if (read !== 'own') problems.push(`${at}.read must be "own" on a customer collection`)
    if (write !== 'own') problems.push(`${at}.write must be "own" on a customer collection`)
    return problems
  }
  const problems: string[] = []
  if (!SHARED_READ_RULES.includes(read as SharedReadRule)) {
    problems.push(`${at}.read must be "public" or "signed_in" on a shared collection`)
  }
  if (
    !Array.isArray(write) ||
    write.length === 0 ||
    write.some((writer) => !SHARED_WRITERS.includes(writer as SharedWriter))
  ) {
    problems.push(
      `${at}.write must list the writers of a shared collection: "feed", "team", "server"`,
    )
  } else if (new Set(write).size !== write.length) {
    problems.push(`${at}.write lists a writer twice`)
  }
  return problems
}

/** What is wrong with a `collections` value, one line per problem; empty when it is valid or absent. */
export function collectionProblems(collections: unknown): string[] {
  if (collections === undefined) return []
  if (!Array.isArray(collections)) return ['collections must be a list']
  const problems: string[] = []
  if (collections.length > MAX_COLLECTIONS) {
    problems.push(`collections has more than ${MAX_COLLECTIONS} entries`)
  }
  const names = new Set<string>()
  const referenced = new Set<string>()
  collections.forEach((collection: unknown, i) => {
    const at = `collections[${i}]`
    if (!isObject(collection)) {
      problems.push(`${at} must be an object`)
      return
    }
    if (isReference(collection)) {
      problems.push(...referenceProblems(collection, at, names, referenced))
      return
    }
    for (const key of unknownKeys(collection, COLLECTION_KEYS)) {
      problems.push(`${at}.${key} is not a known field`)
    }
    if (typeof collection.name !== 'string' || !NAME_PATTERN.test(collection.name)) {
      problems.push(
        `${at}.name must be lower case letters, digits and underscores, starting with a letter (at most 48)`,
      )
    } else if (names.has(collection.name)) {
      problems.push(`${at}.name "${collection.name}" is duplicated`)
    } else {
      names.add(collection.name)
    }
    problems.push(...accessProblems(collection, at))
    const { maxRows } = collection
    if (
      maxRows !== undefined &&
      (typeof maxRows !== 'number' ||
        !Number.isInteger(maxRows) ||
        maxRows < 1 ||
        maxRows > MAX_COLLECTION_ROWS)
    ) {
      problems.push(`${at}.maxRows must be a whole number from 1 to ${MAX_COLLECTION_ROWS}`)
    }
    problems.push(...indexProblems(collection.indexes, at))
  })
  return problems
}

function referenceProblems(
  reference: Record<string, unknown>,
  at: string,
  names: Set<string>,
  referenced: Set<string>,
): string[] {
  const problems: string[] = []
  for (const key of unknownKeys(reference, REFERENCE_KEYS)) {
    problems.push(`${at}.${key} is not a known field of a reference`)
  }
  if (reference.from !== 'account') problems.push(`${at}.from must be "account"`)
  if (reference.access !== 'read' && reference.access !== 'write') {
    problems.push(`${at}.access must be "read" or "write"`)
  }
  const { name } = reference
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    problems.push(
      `${at}.name must be lower case letters, digits and underscores, starting with a letter (at most 48)`,
    )
    return problems
  }
  if (referenced.has(name)) problems.push(`${at}.name "${name}" is referenced twice`)
  referenced.add(name)
  if (
    reference.as !== undefined &&
    (typeof reference.as !== 'string' || !NAME_PATTERN.test(reference.as))
  ) {
    problems.push(
      `${at}.as must be lower case letters, digits and underscores, starting with a letter`,
    )
    return problems
  }
  const local = (reference.as as string | undefined) ?? name
  if (names.has(local)) problems.push(`${at} uses the name "${local}" twice`)
  names.add(local)
  return problems
}

/**
 * What a shared collection may say per data access: `signed_in` needs an
 * identity, which only portal apps have, and `team` a member, which only a
 * team app has.
 */
const SHARED_RULES: Record<string, { read: readonly string[]; write: readonly string[] }> = {
  visitor: { read: ['public'], write: ['feed', 'server'] },
  account: { read: ['public'], write: ['feed', 'server'] },
  customer: { read: ['public', 'signed_in'], write: ['feed', 'server'] },
  team: { read: ['public', 'signed_in'], write: ['feed', 'team', 'server'] },
}

/**
 * A customer collection belongs to an app that serves signed-in customers; a
 * shared one may use the rules its app's data access can serve. Only a value
 * the file states can be checked here: when `dataAccess` is omitted the stored
 * one applies, and the platform checks that.
 */
export function collectionPlacementProblem(config: {
  collections?: unknown
  dataAccess?: string
}): string | null {
  if (!Array.isArray(config.collections) || config.collections.length === 0) return null
  const { dataAccess } = config
  if (dataAccess === undefined) return null
  const rules = SHARED_RULES[dataAccess]
  for (const collection of config.collections as unknown[]) {
    // A reference's rules live on the account collection: the platform checks it.
    if (!isObject(collection) || isReference(collection)) continue
    const name = String(collection.name)
    if ((collection.scope ?? 'customer') === 'customer') {
      if (dataAccess !== 'customer') {
        return `collection "${name}" keeps data for signed-in customers, so the app must have "dataAccess": "customer" (it is "${dataAccess}"). Declare it with "scope": "shared" to keep data that belongs to the app`
      }
      continue
    }
    if (!rules) continue
    if (typeof collection.read === 'string' && !rules.read.includes(collection.read)) {
      return `collection "${name}" may not use read "${collection.read}" in an app with "dataAccess": "${dataAccess}"`
    }
    if (Array.isArray(collection.write)) {
      const writer = collection.write.find(
        (entry: unknown) => typeof entry === 'string' && !rules.write.includes(entry),
      )
      if (writer !== undefined) {
        return `collection "${name}" may not list the writer "${String(writer)}" in an app with "dataAccess": "${dataAccess}"`
      }
    }
  }
  return null
}
