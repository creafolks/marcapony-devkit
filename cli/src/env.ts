import { CliError, EXIT } from './api.js'
import { readConfig, resolveApiRoot } from './config.js'
import { resolveDeployKey } from './credentials.js'

/**
 * `marcapony app env set | list | delete`: the environment's own settings and
 * secrets. The environment comes from the key, as for deploys. A value is
 * read from a hidden prompt or from stdin, never from an argument, so it stays
 * out of the shell history. Nothing pulls secrets down: local development
 * keeps its own values in the local env file.
 */

export interface EnvValue {
  name: string
  kind: 'setting' | 'secret'
  /** Only settings carry a value. */
  value: string | null
  updatedAt: string
  updatedBy: string | null
}

export interface EnvOptions {
  cwd: string
  cliEnv?: string
  env: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  log?: (message: string) => void
}

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/

async function context(options: EnvOptions): Promise<{
  apiRoot: string
  apiKey: string
  fetchImpl: typeof fetch
}> {
  const apiRoot = resolveApiRoot(options.cliEnv)
  const fetchImpl = options.fetchImpl ?? fetch
  const apiKey = readConfig(options.cwd)
    ? await resolveDeployKey({ cwd: options.cwd, env: options.env, apiRoot, fetchImpl })
    : null
  if (!apiKey) {
    throw new CliError('This project is not linked. Run `marcapony app link` first.', {
      exitCode: EXIT.notLinked,
    })
  }
  return { apiRoot, apiKey, fetchImpl }
}

async function failure(res: Response): Promise<CliError> {
  let message = `Request failed with status ${res.status}`
  let code: string | undefined
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    if (body.error?.message) message = body.error.message
    code = body.error?.code
  } catch {
    // keep the generic message
  }
  return new CliError(message, { code, status: res.status })
}

function checkName(name: string | undefined): string {
  if (!name || !NAME.test(name)) {
    throw new CliError(
      'Give a name in capital letters, digits and underscores, for example IYZICO_API_KEY.',
      { exitCode: EXIT.refused },
    )
  }
  if (name.startsWith('MARCAPONY_')) {
    throw new CliError('Names starting with MARCAPONY_ are reserved for the platform.', {
      exitCode: EXIT.refused,
    })
  }
  return name
}

export async function runEnvList(options: EnvOptions & { show?: boolean }): Promise<EnvValue[]> {
  const log = options.log ?? console.log
  const { apiRoot, apiKey, fetchImpl } = await context(options)
  const res = await fetchImpl(`${apiRoot}/ext/v1/environment-values`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw await failure(res)
  const values = ((await res.json()) as { data: EnvValue[] }).data
  if (values.length === 0) log('No values set for this environment.')
  for (const v of values) {
    const shown =
      v.kind === 'secret' ? '(secret)' : options.show ? (v.value ?? '') : '(hidden, --show)'
    log(
      `${v.name.padEnd(28)} ${v.kind.padEnd(8)} ${shown}  ${v.updatedAt}${v.updatedBy ? ` ${v.updatedBy}` : ''}`,
    )
  }
  return values.map((v) => (options.show || v.kind === 'secret' ? v : { ...v, value: null }))
}

export async function runEnvSet(
  options: EnvOptions & {
    name: string | undefined
    secret?: boolean
    /** Where the value comes from: a hidden prompt or stdin. */
    readValue: () => Promise<string>
  },
): Promise<{ name: string; kind: 'setting' | 'secret'; live: string }> {
  const log = options.log ?? console.log
  const name = checkName(options.name)
  const { apiRoot, apiKey, fetchImpl } = await context(options)
  const value = await options.readValue()
  if (value.length === 0) {
    throw new CliError('The value is empty. Nothing was saved.', { exitCode: EXIT.refused })
  }
  const kind = options.secret ? 'secret' : 'setting'
  const res = await fetchImpl(`${apiRoot}/ext/v1/environment-values/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ kind, value }),
  })
  if (!res.ok) throw await failure(res)
  const data = ((await res.json()) as { data: { live: string } }).data
  log(
    data.live === 'applied'
      ? `${name} saved and applied to the running app.`
      : data.live === 'failed'
        ? `${name} saved. The running app gets it with the next deploy.`
        : `${name} saved. It is used from the first deploy.`,
  )
  return { name, kind, live: data.live }
}

export async function runEnvDelete(
  options: EnvOptions & { name: string | undefined },
): Promise<{ name: string; live: string }> {
  const log = options.log ?? console.log
  const name = checkName(options.name)
  const { apiRoot, apiKey, fetchImpl } = await context(options)
  const res = await fetchImpl(`${apiRoot}/ext/v1/environment-values/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw await failure(res)
  const data = ((await res.json()) as { data: { live: string } }).data
  log(`${name} deleted.`)
  return { name, live: data.live }
}

/** The whole of stdin, without the one trailing newline `echo` adds. */
export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '')
}

/** A prompt that does not echo what is typed. */
export async function readHidden(question: string): Promise<string> {
  const stdin = process.stdin
  process.stdout.write(question)
  return await new Promise<string>((resolve, reject) => {
    let value = ''
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const done = (result: string | null): void => {
      stdin.setRawMode?.(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      process.stdout.write('\n')
      if (result === null) reject(new CliError('Cancelled.', { exitCode: EXIT.failed }))
      else resolve(result)
    }
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          done(value)
          return
        }
        if (ch === '\u0003') {
          done(null)
          return
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}
