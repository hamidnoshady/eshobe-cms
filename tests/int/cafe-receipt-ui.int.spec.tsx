import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CheckoutReceipt } from '@/app/(site)/[domain]/[[...path]]/CheckoutReceipt'
import { readOrderForReceipt } from '@/lib/order-receipt'
import type { Order } from '@/payload-types'

vi.mock('@/lib/site-context', () => ({
  getSiteContext: async () => ({ locale: 'fa', site: { id: 'site-id' } }),
}))
vi.mock('@/lib/order-receipt', () => ({ readOrderForReceipt: vi.fn() }))

afterEach(cleanup)

const renderReceipt = async (status: Order['status'], fulfillment: NonNullable<Order['cafe']>['fulfillment']) => {
  vi.mocked(readOrderForReceipt).mockResolvedValue({
    instructions: 'Transfer instructions',
    order: {
      cafe: { fulfillment, serviceMode: 'dine_in', tableLabel: 'میز پنجره', tableToken: 'secret-table-token' },
      currency: 'IRT',
      id: 'order-id',
      payment: { provider: 'counter' },
      reference: 'CMS-A3',
      status,
      total: 125,
    } as Order,
  })
  render(await CheckoutReceipt({ order: 'order-id', receipt: 'signed' }))
}

describe('existing café receipt UI', () => {
  it('shows paid independently of staff approval and renders just the table label', async () => {
    await renderReceipt('paid', 'awaiting_approval')
    expect(screen.getByText('در انتظار تأیید کارکنان')).toBeTruthy()
    expect(screen.getByText('پرداخت‌شده در صندوق')).toBeTruthy()
    expect(screen.getByText('میز پنجره')).toBeTruthy()
    expect(document.body.innerHTML).not.toContain('secret-table-token')
    expect(screen.queryByText('وضعیت آماده‌سازی')).toBeNull()
  })

  it('gives counter instructions while an accepted order is unpaid', async () => {
    await renderReceipt('pending', 'preparing')
    expect(screen.getByText('پذیرفته شد')).toBeTruthy()
    expect(screen.getByText('در حال آماده‌سازی')).toBeTruthy()
    expect(screen.getByText('مبلغ سفارش را در صندوق کافه پرداخت کنید.')).toBeTruthy()
    expect(screen.queryByText('Transfer instructions')).toBeNull()
  })

  it('keeps a paid rejection visible while the refund is being handled', async () => {
    await renderReceipt('paid', 'rejected')
    expect(screen.getByText('رد شد')).toBeTruthy()
    expect(screen.getByText('پرداخت ثبت شده است. کافه وضعیت بازپرداخت را پیگیری می‌کند.')).toBeTruthy()
    expect(screen.queryByText('بازپرداخت شد')).toBeNull()
  })

  it('shows the refund only after the payment status records it', async () => {
    await renderReceipt('refunded', 'rejected')
    expect(screen.getByText('رد شد')).toBeTruthy()
    expect(screen.getByText('بازپرداخت شد')).toBeTruthy()
    expect(screen.queryByText('پرداخت ثبت شده است. کافه وضعیت بازپرداخت را پیگیری می‌کند.')).toBeNull()
  })
})
