import { Hono } from 'hono'
import { errorResponse, marcaponyFromEnv, type MarcaponyBindings } from './marcapony'

/**
 * The app's server. Only `/api/*` reaches this worker — everything else is
 * served from `dist/client` by the platform (see `run_worker_first` in
 * marcapony.json), so there is no static-file handling to write here.
 */
const app = new Hono<{ Bindings: MarcaponyBindings }>()

app.get('/api/health', (c) => c.json({ ok: true }))

/**
 * Example read. The app key never leaves the server: the browser calls this
 * route, and this route calls Marcapony.
 */
/** `Product.status`: 1 draft, 2 published, 3 archived. Show visitors only published products. */
const PUBLISHED = 2

app.get('/api/products', async (c) => {
  const mp = marcaponyFromEnv(c.env)
  // The list has no status filter, so drop drafts and archived products here.
  const page = await mp.products.list({ perPage: 50 })
  const products = page.data.filter((product) => product.status === PUBLISHED).slice(0, 12)
  return c.json({ products })
})

/**
 * Every non-GET call to Marcapony should carry an idempotency key so a retry
 * (yours or the SDK's) cannot create the same thing twice. Derive it from
 * something stable about the request, never from a fresh random per attempt.
 *
 * app.post('/api/orders', async (c) => {
 *   const body = await c.req.json()
 *   const mp = marcaponyFromEnv(c.env)
 *   const order = await mp.orders.create(body, { idempotencyKey: body.requestId })
 *   return c.json(order, 201)
 * })
 */

app.onError((err) => errorResponse(err))

export default app
