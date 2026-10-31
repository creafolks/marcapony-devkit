import { useEffect, useState } from 'react'

interface Product {
  id: string
  name: string
  // Nullable in the API: a product does not have to carry a price.
  price: number | null
  currency: string | null
}

function formatPrice({ price, currency }: Product): string {
  if (price === null) return '—'
  return currency ? `${price} ${currency}` : String(price)
}

/**
 * Calls this app's own `/api` route, never Marcapony directly — the app key
 * lives on the server and must stay there.
 */
export function App() {
  const [products, setProducts] = useState<Product[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/products')
      .then(async (res) => {
        const body = (await res.json()) as { products?: Product[]; error?: string }
        if (!res.ok) throw new Error(body.error ?? `Request failed with status ${res.status}`)
        setProducts(body.products ?? [])
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Request failed'))
  }, [])

  return (
    <main>
      <h1>Your Marcapony app</h1>
      <p>
        Edit <code>src/ui/App.tsx</code> for the UI and <code>src/server/index.ts</code> for the
        API.
      </p>

      <h2>Products</h2>
      {error ? <p className="error">{error}</p> : null}
      {!error && products === null ? <p>Loading…</p> : null}
      {products?.length === 0 ? <p>No products in this account yet.</p> : null}
      <ul>
        {products?.map((product) => (
          <li key={product.id}>
            {product.name} — {formatPrice(product)}
          </li>
        ))}
      </ul>
    </main>
  )
}
