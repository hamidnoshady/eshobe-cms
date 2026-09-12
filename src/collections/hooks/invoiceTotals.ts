import type { CollectionBeforeChangeHook, CollectionBeforeValidateHook } from 'payload'

import { invoiceNumber, invoiceTotals } from '@/lib/saas/plans'

/**
 * An invoice's numbers, derived — never accepted from the caller.
 *
 * `subtotal`, `tax`, `total` and each line's `amount` all have `access.update: false`,
 * which per CLAUDE.md's Payload note means a caller's value is *dropped in
 * `beforeValidate`* and the stored one falls through. A collection `beforeChange`
 * hook still writes them, which is exactly the "derived column, unwritable from
 * outside, correct from inside" shape `payment-gateways.title` uses.
 *
 * So the guarantee is not "we validate the total the client sent" — it is that the
 * client's total never existed. An invoice whose printed figure disagrees with the
 * sum of its lines cannot be constructed through any API this deployment exposes.
 */
export const computeInvoiceTotals: CollectionBeforeChangeHook = ({ data }) => {
  const input = (data ?? {}) as {
    discount?: unknown
    lines?: { description?: unknown; id?: unknown; quantity?: unknown; unitAmount?: unknown }[]
    paidAt?: unknown
    status?: unknown
    taxPercent?: unknown
  }

  const totals = invoiceTotals(
    (input.lines ?? []).map((line) => ({
      description: typeof line?.description === 'string' ? line.description : '',
      quantity: Number(line?.quantity ?? 1),
      unitAmount: Number(line?.unitAmount ?? 0),
    })),
    { discount: Number(input.discount ?? 0), taxPercent: Number(input.taxPercent ?? 0) },
  )

  // Row ids are preserved: a rewritten array drops them, and Payload treats a row
  // with no id as a delete-and-recreate — the same rule the snapshot importer
  // follows for block rows (CLAUDE.md, Payload section).
  data.lines = (input.lines ?? []).map((line, index) => ({
    ...line,
    amount: totals.lines[index]?.amount ?? 0,
  }))

  data.discount = totals.discount
  data.subtotal = totals.subtotal
  data.tax = totals.tax
  data.total = totals.total

  // Recording payment *is* marking it paid. Two places to say the same thing is how
  // a paid invoice ends up in a dunning report.
  if (input.paidAt && input.status !== 'void' && input.status !== 'uncollectible') {
    data.status = 'paid'
  }

  return data
}

/**
 * `INV-2026-000042`, assigned once at creation and never again.
 *
 * The sequence is `count + 1` over the collection, which is a race under concurrent
 * creates — two invoices issued in the same millisecond could contend for one
 * number, and the `unique` index on the column is what turns that into a failed
 * save rather than a duplicate. That is the right trade here: invoices are created
 * by an operator or by the nightly renewal job, so the contention is theoretical,
 * and the alternative (a sequence table, or raw SQL outside a migration) buys
 * nothing this deployment needs. The failure is loud and retryable.
 */
export const stampInvoiceNumber: CollectionBeforeValidateHook = async ({ data, operation, req }) => {
  if (operation !== 'create') return data
  if (typeof (data as { number?: unknown })?.number === 'string' && (data as { number: string }).number) return data

  const { totalDocs } = await req.payload.count({ collection: 'invoices', overrideAccess: true, req })

  return { ...data, number: invoiceNumber(totalDocs + 1) }
}
