import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where `marcapony login` keeps its credentials: the operating system's
 * keychain (macOS Keychain, Windows Credential Manager, libsecret) through the
 * optional `@napi-rs/keyring`, or, only when asked with `--insecure-file`, a
 * file readable by the user alone. Never the project directory.
 *
 * Next to the secrets, a small index (`logins.json`, no secrets) remembers
 * which logins exist, so `marcapony login status` can list them without
 * searching the keychain.
 */

export type LoginStorage = 'keychain' | 'file'

export interface LoginRecord {
  /** The API root the login belongs to; staging and production logins coexist. */
  apiRoot: string
  accountId: string
  accountSlug: string | null
  accountName: string | null
  userEmail: string | null
  credentialId: string
  expiresAt: string
  storage: LoginStorage
}

/** Secret storage. A test passes its own; the CLI resolves the keychain or the file. */
export interface SecretStore {
  readonly kind: LoginStorage
  get(key: string): Promise<string | null>
  set(key: string, secret: string): Promise<void>
  delete(key: string): Promise<void>
}

const SERVICE = 'marcapony'

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MARCAPONY_CONFIG_DIR) return env.MARCAPONY_CONFIG_DIR
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'marcapony')
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'marcapony')
}

/** The keychain entry name: one per API host and account. */
export function secretKey(record: Pick<LoginRecord, 'apiRoot' | 'accountId'>): string {
  return `${new URL(record.apiRoot).host}:${record.accountId}`
}

interface KeyringEntry {
  getPassword(): string | null | undefined
  setPassword(password: string): void
  deletePassword(): unknown
}
type KeyringModule = { Entry: new (service: string, account: string) => KeyringEntry }

/**
 * The keychain, or null when the optional native module is missing or the
 * system has no secret service (a headless Linux box). A probe read decides:
 * a working keychain answers "no such entry", a missing one throws.
 */
export async function keychainStore(
  load: () => Promise<unknown> = () => import('@napi-rs/keyring'),
): Promise<SecretStore | null> {
  let mod: KeyringModule
  try {
    mod = (await load()) as KeyringModule
    if (typeof mod?.Entry !== 'function') return null
  } catch {
    return null
  }
  try {
    new mod.Entry(SERVICE, '__probe__').getPassword()
  } catch (err) {
    // "No such entry" means the keychain works and is simply empty there.
    if (!/no (matching )?entry|not found/i.test(err instanceof Error ? err.message : String(err))) {
      return null
    }
  }
  return {
    kind: 'keychain',
    async get(key) {
      try {
        return new mod.Entry(SERVICE, key).getPassword() ?? null
      } catch {
        return null
      }
    },
    async set(key, secret) {
      new mod.Entry(SERVICE, key).setPassword(secret)
    },
    async delete(key) {
      try {
        new mod.Entry(SERVICE, key).deletePassword()
      } catch {
        // Already gone.
      }
    },
  }
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writePrivate(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  // An existing file keeps its old mode on write; tighten it every time.
  try {
    chmodSync(path, 0o600)
  } catch {
    // Not supported on this filesystem (Windows): the user profile protects it.
  }
}

/** `--insecure-file`: `credentials.json` in the config directory, mode 0600. */
export function fileStore(dir: string = configDir()): SecretStore {
  const path = join(dir, 'credentials.json')
  const read = () => readJson<Record<string, string>>(path, {})
  return {
    kind: 'file',
    async get(key) {
      return read()[key] ?? null
    },
    async set(key, secret) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writePrivate(path, { ...read(), [key]: secret })
    },
    async delete(key) {
      if (!existsSync(path)) return
      const next = read()
      delete next[key]
      writePrivate(path, next)
    },
  }
}

/** The index of logins (no secrets). */
export class LoginIndex {
  constructor(private readonly dir: string = configDir()) {}

  private get path(): string {
    return join(this.dir, 'logins.json')
  }

  all(): LoginRecord[] {
    const list = readJson<LoginRecord[]>(this.path, [])
    return Array.isArray(list) ? list : []
  }

  forApi(apiRoot: string): LoginRecord[] {
    return this.all().filter((record) => record.apiRoot === apiRoot)
  }

  find(apiRoot: string, accountId: string): LoginRecord | undefined {
    return this.all().find((r) => r.apiRoot === apiRoot && r.accountId === accountId)
  }

  save(record: LoginRecord): void {
    const rest = this.all().filter(
      (r) => !(r.apiRoot === record.apiRoot && r.accountId === record.accountId),
    )
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    writePrivate(this.path, [...rest, record])
  }

  remove(record: Pick<LoginRecord, 'apiRoot' | 'accountId'>): void {
    const rest = this.all().filter(
      (r) => !(r.apiRoot === record.apiRoot && r.accountId === record.accountId),
    )
    if (rest.length === this.all().length) return
    writePrivate(this.path, rest)
  }
}

/** The store a record's secret lives in. */
export async function storeFor(
  storage: LoginStorage,
  dir: string = configDir(),
): Promise<SecretStore | null> {
  return storage === 'file' ? fileStore(dir) : keychainStore()
}
