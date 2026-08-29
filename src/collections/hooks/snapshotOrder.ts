import type { CollectionBeforeValidateHook } from 'payload'

import { randomBytes } from 'crypto'

/**
 * Eight digits, not hex. A code is read out loud over the phone and rendered on a
 * Persian page, where `toLocaleDigits` turns `9F3C` into `۹F۳C` — a mixed-script
 * stutter. Digits-only codes render as `۹۳۴۸۵۱۲۰`, which is a thing a person can
 * actually say.
 */
const CODE = '0123456789'

const codeDigits = (count: number): string => {
  const bytes = randomBytes(count)

  return [...bytes].map((byte) => CODE[byte % 10]).join('')
}

import { idOf } from '@/lib/ids'

/**
 * The one implementation of the code's shape. Exported because the storefront's
 * checkout path passes it in rather than relying on this hook — Payload's generated
 * create-data types require every `required` field to be present in the call, and
 * `reference` has no way to know a hook is about to fill it.
 */
export const newOrderReference = (): string => `ESH-${codeDigits(8)}`

/**
 * `ESH-XXXXXXXX` (eight digits) — the code a buyer reads out over the phone.
 *
 * Random, not sequential: a per-site counter would need its own table to be
 * race-free, and would tell anyone who guesses the next id how much the store has
 * sold. It is deliberately *not* `unique` in the database and is not a lookup key —
 * the id is. Two sites can hold the same code, and if one site ever draws it twice
 * the list view shows two rows with the same label; that is a cosmetic accident in a
 * column nobody filters by, whereas a unique index would fail the *order write*
 * itself. A paid order is not worth losing to a label collision.
 *
 * Both fields are filled in for admin creates too: an owner recording a telephone
 * order should not have to invent a code by hand, and should not have to retype a
 * product name that is already on the document the order points at.
 *
 * `productTitle` is a snapshot for the same reason `unitPrice` is: the product row is
 * editable, and an order's history is not.
 */
export const snapshotOrder: CollectionBeforeValidateHook = async ({
  data,
  operation,
  req,
}) => {
  if (operation !== 'create') return data

  const next = { ...data }

  if (!next.reference) {
    next.reference = newOrderReference()
  }

  const productId = idOf(next.product)

  if (!next.productTitle && productId) {
    // `overrideAccess: true` because a site's editor is allowed to record an order for
    // a product they can already see; the *site* predicate is the part that matters.
    const product = await req.payload
      .find({
        collection: 'products',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        req,
        select: { site: true, title: true },
        where: {
          and: [{ id: { equals: productId } }, { site: { equals: idOf(next.site) ?? '' } }],
        },
      })
      .then(({ docs }) => docs[0] as { title?: string } | undefined)

    if (product?.title) next.productTitle = product.title
  }

  return next
}
