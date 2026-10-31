/**
 * Local dev: Vite serves the UI and proxies `/api` here, where the same Hono app
 * that ships to production handles the request.
 *
 * Caveat worth knowing: this runs under Bun, not the Workers runtime. The two
 * are close but not identical, so a deployed app can still surface something
 * local dev did not. Verify after `bun run deploy`, and prefer plain
 * web APIs (fetch, Request, Response, crypto) over Node built-ins in
 * `src/server` — those are the ones that behave the same in both.
 */
import { readFileSync, existsSync } from 'node:fs'
import app from '../src/server/index'

const API_PORT = 8787
const ENV_FILE = '.dev.vars'

function loadDevVars(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

function readPlacement(): string | undefined {
  try {
    const config = JSON.parse(readFileSync('marcapony.json', 'utf8')) as { placement?: string }
    return config.placement
  } catch {
    return undefined
  }
}

const env = loadDevVars()
if (!env.MARCAPONY_API_KEY) {
  console.warn(
    `No MARCAPONY_API_KEY in ${ENV_FILE} — /api routes that call Marcapony will fail.\nRun \`bun run link\` to get one.`,
  )
}

// A portal app only learns who is signed in from a header the platform adds,
// using the app id it sets at deploy. Neither exists here.
if (!env.MARCAPONY_APP_ID && readPlacement() === 'portal') {
  console.info(
    'Local dev has no app id and no signed-in visitor, so identity is null and signed-in routes answer 401.\nTry those flows on the deployed app (`bun run deploy`), opened from the portal or the dashboard.',
  )
}

const vite = Bun.spawn(['bunx', 'vite', 'dev'], { stdout: 'inherit', stderr: 'inherit' })

const server = Bun.serve({
  port: API_PORT,
  fetch: (request) => app.fetch(request, env),
})

console.info(`API on http://localhost:${server.port} — open the URL Vite prints above.`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    vite.kill()
    server.stop()
    process.exit(0)
  })
}

await vite.exited
server.stop()
