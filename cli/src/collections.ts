/**
 * `collections` in `marcapony.json`: the records an app in the customer portal
 * keeps for each signed-in customer (`mp.forRequest(request).me.records(name)`
 * in the SDK). Checked here with the platform's rules so a mistake is reported
 * before the build; the platform checks again on deploy.
 */
export interface CollectionDeclaration {
  /** Lower case letters, digits and underscores, starting with a letter. */
  name: string
  /** Who may read a record. `own`: the customer it belongs to. */
  read: 'own'
  /** Who may write a record. `own`: the customer it belongs to. */
  write: 'own'
  /** Records one customer may hold in this collection. 1 to 10,000; 1,000 when omitted. */
  maxRows?: number
  /** Top-level fields of `data` a list may filter and order by. At most 4. */
  indexes?: Array<{ field: string; type: CollectionIndexType }>
}

export const COLLECTION_INDEX_TYPES = ['string', 'number', 'date', 'boolean'] as const
export type CollectionIndexType = (typeof COLLECTION_INDEX_TYPES)[number]

export const MAX_COLLECTIONS = 16
export const MAX_COLLECTION_INDEXES = 4
export const MAX_COLLECTION_ROWS = 10_000

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,47}$/
const COLLECTION_KEYS = ['name', 'read', 'write', 'maxRows', 'indexes']
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

/** What is wrong with a `collections` value, one line per problem; empty when it is valid or absent. */
export function collectionProblems(collections: unknown): string[] {
  if (collections === undefined) return []
  if (!Array.isArray(collections)) return ['collections must be a list']
  const problems: string[] = []
  if (collections.length > MAX_COLLECTIONS) {
    problems.push(`collections has more than ${MAX_COLLECTIONS} entries`)
  }
  const names = new Set<string>()
  collections.forEach((collection: unknown, i) => {
    const at = `collections[${i}]`
    if (!isObject(collection)) {
      problems.push(`${at} must be an object`)
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
    for (const access of ['read', 'write'] as const) {
      if (collection[access] !== 'own') problems.push(`${at}.${access} must be "own"`)
    }
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

/**
 * Collections belong to an app that serves signed-in customers. Only a value
 * the file states can be checked here: when `dataAccess` is omitted the stored
 * one applies, and the platform checks that.
 */
export function collectionPlacementProblem(config: {
  collections?: unknown
  dataAccess?: string
}): string | null {
  if (!Array.isArray(config.collections) || config.collections.length === 0) return null
  if (config.dataAccess === undefined || config.dataAccess === 'customer') return null
  return `collections keep data for signed-in customers, so the app must have "dataAccess": "customer" (it is "${config.dataAccess}")`
}
