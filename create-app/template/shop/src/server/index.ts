import { Hono } from 'hono'
import type { PaymentLink, PaymentLinkLineItem, Product } from 'marcapony-sdk'
import { errorResponse, marcaponyFromEnv, type MarcaponyBindings } from './marcapony'

/**
 * A small public shop: the catalog, a cart kept in the browser, and a checkout
 * that turns the cart into a hosted payment link. Only `/api/*` reaches this
 * worker; everything else is served from `dist/client`.
 *
 * The browser only ever sends product ids and quantities. Prices, currency and
 * the total are read from the catalog here, on every checkout.
 */
const app = new Hono<{ Bindings: MarcaponyBindings }>()

const MAX_LINES = 20
const MAX_QUANTITY = 99
const ATTEMPT_ID = /^[A-Za-z0-9-]{8,64}$/

/** What the browser sees of a product: enough to show it, nothing to trust. */
interface ShopProduct {
  id: string
  name: string
  description: string
  categoryName: string | null
  price: number
  currency: string
  inStock: boolean
}

/** The price a buyer pays: the sale price when there is one. Null when the product has no price. */
function unitPrice(product: Product): number | null {
  return product.salePrice ?? product.price
}

function toShopProduct(product: Product, fallbackCurrency: string): ShopProduct | null {
  const price = unitPrice(product)
  if (price === null) return null
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    categoryName: product.categoryName,
    price,
    currency: product.currency ?? fallbackCurrency,
    inStock: !product.trackStock || product.stock === null || product.stock > 0,
  }
}

async function cartFingerprint(quantities: Map<string, number>): Promise<string> {
  const canonical = [...quantities.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, quantity]) => `${id}:${quantity}`)
    .join(',')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/api/catalog', async (c) => {
  const mp = marcaponyFromEnv(c.env)
  const category = c.req.query('category') || undefined
  const [site, categories, page] = await Promise.all([
    mp.site.get(),
    mp.categories.list(),
    // `category` is a category slug.
    mp.products.list({ perPage: 50, category }),
  ])
  const products = page.data
    .map((product) => toShopProduct(product, site.defaultCurrency))
    .filter((product): product is ShopProduct => product !== null)
  return c.json({
    shopName: site.name,
    categories: categories.map(({ id, name, slug }) => ({ id, name, slug })),
    products,
  })
})

interface CheckoutBody {
  attemptId?: unknown
  items?: unknown
}

app.post('/api/checkout', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CheckoutBody
  if (typeof body.attemptId !== 'string' || !ATTEMPT_ID.test(body.attemptId)) {
    return c.json({ error: 'attemptId is missing or malformed.' }, 400)
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: 'The cart is empty.' }, 400)
  }

  // Merge repeated lines and refuse anything that is not an id and a whole quantity.
  const quantities = new Map<string, number>()
  for (const item of body.items as Array<{ productId?: unknown; quantity?: unknown }>) {
    const { productId, quantity } = item ?? {}
    if (typeof productId !== 'string' || productId.length === 0) {
      return c.json({ error: 'Every cart line needs a productId.' }, 400)
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
      return c.json({ error: 'Quantities must be whole numbers of at least 1.' }, 400)
    }
    quantities.set(productId, (quantities.get(productId) ?? 0) + quantity)
  }
  if (quantities.size > MAX_LINES) {
    return c.json({ error: `A cart holds at most ${MAX_LINES} different products.` }, 400)
  }

  const mp = marcaponyFromEnv(c.env)
  const site = await mp.site.get()
  // Re-read every product: prices in the browser are for display only.
  const products = await Promise.all([...quantities.keys()].map((id) => mp.products.get(id)))

  const lineItems: PaymentLinkLineItem[] = []
  let currency: string | null = null
  let totalCents = 0
  for (const product of products) {
    const quantity = quantities.get(product.id) ?? 0
    const price = unitPrice(product)
    if (price === null) return c.json({ error: `${product.name} cannot be bought online.` }, 422)
    if (quantity > MAX_QUANTITY) {
      return c.json({ error: `At most ${MAX_QUANTITY} of ${product.name}.` }, 422)
    }
    if (product.trackStock && product.stock !== null && product.stock < quantity) {
      return c.json({ error: `Only ${product.stock} of ${product.name} left.` }, 422)
    }
    const lineCurrency = product.currency ?? site.defaultCurrency
    if (currency !== null && currency !== lineCurrency) {
      return c.json({ error: 'Products in different currencies cannot share one checkout.' }, 422)
    }
    currency = lineCurrency
    // Whole cents, so the total does not pick up floating point noise.
    totalCents += Math.round(price * 100) * quantity
    lineItems.push({
      name: product.name,
      price,
      quantity,
      productId: product.id,
      ...(product.categoryId ? { categoryId: product.categoryId } : {}),
    })
  }

  const amount = totalCents / 100
  // One attempt id per checkout attempt, reused by the browser when it retries
  // the same cart, so a retry cannot create a second link. The cart's contents
  // are part of the key too: a reused attempt id with a different cart must
  // not be answered with the earlier cart's link.
  const idempotencyKey = `checkout-${body.attemptId}-${await cartFingerprint(quantities)}`
  const link = (await mp.paymentLinks.create(
    {
      title: `${site.name} order`,
      amount,
      currency: currency ?? site.defaultCurrency,
      lineItems,
    },
    { idempotencyKey },
  )) as PaymentLink

  // The SDK returns the link's short id; the buyer pays it at /pay/{linkId} on
  // the business's site.
  const payUrl = site.domain ? `https://${site.domain}/pay/${encodeURIComponent(link.linkId)}` : null
  return c.json({ amount, currency: link.currency ?? currency, payUrl, linkId: link.linkId }, 201)
})

app.onError((err) => errorResponse(err))

export default app
