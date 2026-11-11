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
    // ESH-150: with no table token on the page, the cart submits itself as a takeaway
    // order and names a payment choice — never a table id, and never a client price.
    expect(body.serviceMode).toBe('takeaway')
    expect(body.tableToken).toBeUndefined()
    expect(typeof body.checkoutRequestId).toBe('string')
    expect(body.checkoutRequestId.length).toBeGreaterThanOrEqual(8)
    expect(await screen.findByText('Price changed')).toBeTruthy()
  })

  it('defaults to dine-in when the QR link carried a table token, and offers pay at the counter', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ message: 'nope' }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<CafeMenuClient categories={[{ id: 'drinks', name: 'Drinks' }]} currency="IRT" locale="en" paymentMethods={[]} products={products} showBuyButton tableToken="TBL_9f2c1a4e77b04d0f8c31ab77" />)

    const cart = within(screen.getByRole('complementary', { name: 'Your cart' }))
    const coffee = within(screen.getAllByRole('article')[0]!)
    fireEvent.click(coffee.getByRole('checkbox', { name: /Oat/ }))
    fireEvent.click(coffee.getByRole('button', { name: 'Add to cart' }))

    // A scanned table preselects dine-in…
    expect((cart.getByRole('radio', { name: /At a table/ }) as HTMLInputElement).checked).toBe(true)
    // …and a site with no gateway still offers pay at the counter, preselected.
    expect((cart.getByRole('radio', { name: /Pay at the counter/ }) as HTMLInputElement).checked).toBe(true)
    // No gateway is configured on this site, so online payment is not offered at all.
    expect(cart.queryByRole('radio', { name: 'Pay online' })).toBeNull()

    fireEvent.change(cart.getByLabelText('Full name'), { target: { value: 'Table Four' } })
    fireEvent.change(cart.getByLabelText('Phone'), { target: { value: '09123456789' } })
    fireEvent.submit(cart.getByRole('button', { name: 'Submit' }).closest('form')!)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body.serviceMode).toBe('dine_in')
    expect(body.tableToken).toBe('TBL_9f2c1a4e77b04d0f8c31ab77')
    expect(body.paymentChoice).toBe('counter')
    expect(body.gateway).toBeUndefined()
  })

  it('refuses to submit a dine-in choice the page cannot honour', async () => {
    // No `?t=` on the page: there is no table to attribute the order to, so the dine-in
    // radio is inert and the cart submits as takeaway.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<CafeMenuClient categories={[]} currency="IRT" locale="en" paymentMethods={[]} products={products} showBuyButton />)
    const cart = within(screen.getByRole('complementary', { name: 'Your cart' }))
    fireEvent.click(within(screen.getAllByRole('article')[1]!).getByRole('button', { name: 'Add to cart' }))

    expect((cart.getByRole('radio', { name: /At a table/ }) as HTMLInputElement).disabled).toBe(true)
    expect((cart.getByRole('radio', { name: 'Takeaway' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.change(cart.getByLabelText('Full name'), { target: { value: 'No Table' } })
    fireEvent.change(cart.getByLabelText('Phone'), { target: { value: '09123456789' } })
    fireEvent.submit(cart.getByRole('button', { name: 'Submit' }).closest('form')!)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body.serviceMode).toBe('takeaway')
    expect(body.tableToken).toBeUndefined()
  })

  it('keeps one request id across a retried submit and changes it when the basket does', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'Network blip' }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'Network blip' }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<CafeMenuClient categories={[{ id: 'drinks', name: 'Drinks' }]} currency="IRT" locale="en" paymentMethods={[]} products={products} showBuyButton />)

    const cart = within(screen.getByRole('complementary', { name: 'Your cart' }))
    const cake = within(screen.getAllByRole('article')[1]!)
    fireEvent.click(cake.getByRole('button', { name: 'Add to cart' }))
    fireEvent.change(cart.getByLabelText('Full name'), { target: { value: 'Retry Buyer' } })
    fireEvent.change(cart.getByLabelText('Phone'), { target: { value: '09123456789' } })
    const form = cart.getByRole('button', { name: 'Submit' }).closest('form')!

    fireEvent.submit(form)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    // An unchanged basket retried is the same order: same key.
    fireEvent.submit(form)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    const firstId = JSON.parse(fetchMock.mock.calls[0]![1].body).checkoutRequestId
    const secondId = JSON.parse(fetchMock.mock.calls[1]![1].body).checkoutRequestId
    expect(secondId).toBe(firstId)

    // Adding a second cake makes it a different order, so the key moves with it.
    fireEvent.click(cake.getByRole('button', { name: 'Add to cart' }))
    fireEvent.submit(form)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body).checkoutRequestId).not.toBe(firstId)
  })
})
