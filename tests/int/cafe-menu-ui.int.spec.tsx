import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CafeMenuClient } from '@/blocks/ProductGrid/CafeMenuClient'
import type { CafeMenuItem } from '@/blocks/ProductGrid/cafeTypes'

const products: CafeMenuItem[] = [
  {
    id: 'coffee', title: 'Coffee', summary: 'Freshly brewed', image: null, price: 100, categoryIds: ['drinks'],
    menuAvailability: 'available', productType: 'simple', variations: [],
    modifierGroups: [{ sourceId: 'milk', label: 'Milk', minSelections: 1, maxSelections: 1, options: [
      { sourceId: 'oat', label: 'Oat', priceDelta: 25 }, { sourceId: 'dairy', label: 'Dairy', priceDelta: -5 },
      { sourceId: 'off', label: 'Not offered', priceDelta: 0, active: false },
    ] }],
  },
  { id: 'cake', title: 'Cake', image: null, price: 200, categoryIds: ['desserts'], variations: [], modifierGroups: [] },
  { id: 'sold', title: 'Sold out cake', image: null, price: 300, categoryIds: ['desserts'], menuAvailability: 'sold_out', variations: [], modifierGroups: [] },
]

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('café menu UI', () => {
  it('requires modifiers and builds separate configurations and products in a client-only draft', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ message: 'Price changed' }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<CafeMenuClient categories={[{ id: 'drinks', name: 'Drinks' }, { id: 'desserts', name: 'Desserts' }]} currency="IRT" locale="en" paymentMethods={[]} products={products} showBuyButton />)
    expect(screen.getByRole('navigation', { name: 'Menu categories' }).textContent).toContain('Drinks')
    const cards = screen.getAllByRole('article')
    const coffee = within(cards[0]!)
    const coffeeButton = coffee.getByRole('button', { name: 'Add to cart' }) as HTMLButtonElement
    expect(coffeeButton.disabled).toBe(true)
    expect(coffee.queryByText('Not offered')).toBeNull()
    expect((within(cards[2]!).getByRole('button', { name: 'Add to cart' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(coffee.getByRole('checkbox', { name: /Oat/ }))
    expect(coffeeButton.disabled).toBe(false)
    expect((coffee.getByRole('checkbox', { name: /Dairy/ }) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(coffeeButton)
    fireEvent.click(coffee.getByRole('checkbox', { name: /Oat/ }))
    fireEvent.click(coffee.getByRole('checkbox', { name: /Dairy/ }))
    fireEvent.click(coffeeButton)
    fireEvent.click(within(cards[1]!).getByRole('button', { name: 'Add to cart' }))

    const cart = within(screen.getByRole('complementary', { name: 'Your cart' }))
    expect(cart.getAllByText('Coffee')).toHaveLength(2)
    expect(cart.getByText('Milk: Oat')).toBeTruthy()
    expect(cart.getByText('Milk: Dairy')).toBeTruthy()
    expect(cart.getByText('Cake')).toBeTruthy()
    fireEvent.change(cart.getByLabelText('Full name'), { target: { value: 'Test Buyer' } })
    fireEvent.change(cart.getByLabelText('Phone'), { target: { value: '09123456789' } })
    fireEvent.submit(cart.getByRole('button', { name: 'Submit' }).closest('form')!)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const [url, options] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/checkout')
    const body = JSON.parse(options.body)
    expect(body.items).toEqual([
      { product: 'coffee', quantity: 1, modifiers: [{ groupId: 'milk', optionIds: ['oat'] }] },
      { product: 'coffee', quantity: 1, modifiers: [{ groupId: 'milk', optionIds: ['dairy'] }] },
      { product: 'cake', quantity: 1, modifiers: [] },
    ])
    expect(body.total).toBeUndefined()
    expect(body.items[0].unitPrice).toBeUndefined()
    expect(await screen.findByText('Price changed')).toBeTruthy()
  })
})
