import { useEffect, useMemo, useState } from 'react'
import { api, errorMessage, newRequestId } from './api'

interface ShopProduct {
  id: string
  name: string
  description: string
  categoryName: string | null
  price: number
  currency: string
  inStock: boolean
}

interface Category {
  id: string
  name: string
  slug: string
}

interface Catalog {
  shopName: string
  categories: Category[]
  products: ShopProduct[]
}

interface CheckoutResult {
  amount: number
  currency: string
  payUrl: string | null
  linkId: string
}

/** productId → quantity. Only ids and quantities: the server prices the cart. */
type Cart = Record<string, number>

const CART_KEY = 'cart'

function loadCart(): Cart {
  try {
    const parsed = JSON.parse(localStorage.getItem(CART_KEY) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Cart) : {}
  } catch {
    return {}
  }
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount} ${currency}`
  }
}

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [category, setCategory] = useState('')
  const [cart, setCart] = useState<Cart>(loadCart)
  // Products seen so far, so cart lines stay readable when a category filter hides them.
  const [known, setKnown] = useState<Record<string, ShopProduct>>({})
  // One id per checkout attempt. A retry of the same cart reuses it; any change
  // to the cart starts a new attempt.
  const [attemptId, setAttemptId] = useState(newRequestId)
  const [result, setResult] = useState<CheckoutResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const query = category ? `?category=${encodeURIComponent(category)}` : ''
    api<Catalog>(`/api/catalog${query}`)
      .then((body) => {
        setCatalog(body)
        setKnown((previous) => ({
          ...previous,
          ...Object.fromEntries(body.products.map((product) => [product.id, product])),
        }))
      })
      .catch((err: unknown) => setError(errorMessage(err)))
  }, [category])

  useEffect(() => {
    localStorage.setItem(CART_KEY, JSON.stringify(cart))
  }, [cart])

  function changeQuantity(productId: string, delta: number) {
    setCart((previous) => {
      const next = { ...previous }
      const quantity = (next[productId] ?? 0) + delta
      if (quantity > 0) next[productId] = quantity
      else delete next[productId]
      return next
    })
    setAttemptId(newRequestId())
    setResult(null)
  }

  const lines = useMemo(
    () =>
      Object.entries(cart).map(([productId, quantity]) => ({
        productId,
        quantity,
        product: known[productId],
      })),
    [cart, known],
  )

  async function checkout() {
    setBusy(true)
    setError(null)
    try {
      const body = await api<CheckoutResult>('/api/checkout', {
        body: {
          attemptId,
          items: lines.map(({ productId, quantity }) => ({ productId, quantity })),
        },
      })
      setResult(body)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>{catalog?.shopName ?? 'Shop'}</h1>
      {error ? <p className="error">{error}</p> : null}

      {catalog && catalog.categories.length > 0 ? (
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All products</option>
            {catalog.categories.map((c) => (
              <option key={c.id} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <h2>Products</h2>
      {catalog === null && !error ? <p>Loading…</p> : null}
      {catalog?.products.length === 0 ? <p>No products to show yet.</p> : null}
      <ul className="rows">
        {catalog?.products.map((product) => (
          <li key={product.id}>
            <span>
              {product.name} <span className="muted">{money(product.price, product.currency)}</span>
            </span>
            <button
              type="button"
              disabled={!product.inStock}
              onClick={() => changeQuantity(product.id, 1)}
            >
              {product.inStock ? 'Add to cart' : 'Out of stock'}
            </button>
          </li>
        ))}
      </ul>

      <h2>Cart</h2>
      {lines.length === 0 ? <p>Your cart is empty.</p> : null}
      <ul className="rows">
        {lines.map(({ productId, quantity, product }) => (
          <li key={productId}>
            <span>
              {product?.name ?? 'Product'} × {quantity}
              {product ? (
                <span className="muted"> {money(product.price * quantity, product.currency)}</span>
              ) : null}
            </span>
            <span className="actions">
              <button type="button" onClick={() => changeQuantity(productId, -1)}>
                −
              </button>
              <button type="button" onClick={() => changeQuantity(productId, 1)}>
                +
              </button>
            </span>
          </li>
        ))}
      </ul>
      {lines.length > 0 && !result ? (
        <p>
          <button type="button" disabled={busy} onClick={() => void checkout()}>
            {busy ? 'Preparing payment…' : 'Checkout'}
          </button>
        </p>
      ) : null}

      {result ? (
        <section>
          <h2>Ready to pay</h2>
          <p>Total: {money(result.amount, result.currency)}</p>
          {result.payUrl ? (
            <p>
              <a href={result.payUrl}>Pay now</a>
            </p>
          ) : (
            <p className="muted">Payment link {result.linkId} was created.</p>
          )}
        </section>
      ) : null}
    </main>
  )
}
