import { describe, expect, it } from 'bun:test'
import type { CreatedPaymentLink, WriteResult } from '../index.js'

function payUrl(result: WriteResult<CreatedPaymentLink>): string | null {
  if (result.simulated) return null
  return result.paymentUrl
}

describe('WriteResult', () => {
  it('narrows a saved record to the full type', () => {
    const saved: WriteResult<CreatedPaymentLink> = {
      id: 'pl_1',
      linkId: 'abc',
      title: 'Order 1',
      currency: 'TRY',
      status: 'pending',
      expiresAt: null,
      createdAt: '2026-10-31T00:00:00Z',
      paymentUrl: 'https://example.com/pay/abc',
    }
    expect(payUrl(saved)).toBe('https://example.com/pay/abc')
  })

  it('narrows a test-mode echo, which has no server-computed fields', () => {
    const simulated: WriteResult<CreatedPaymentLink> = {
      id: 'test_1',
      linkId: 'test_1',
      title: 'Order 1',
      createdAt: '2026-10-31T00:00:00Z',
      updatedAt: '2026-10-31T00:00:00Z',
      simulated: true,
    }
    expect(payUrl(simulated)).toBeNull()
  })
})
