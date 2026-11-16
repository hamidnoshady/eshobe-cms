import type { CollectionBeforeValidateHook } from 'payload'

import { ValidationError } from 'payload'

import { requestApiKey } from '@/access/siteApiKey'
import type { Order } from '@/payload-types'

/** Legacy store keys can write payment status. Café state uses the POS endpoint. */
export const restrictApiKeyOrderWrite: CollectionBeforeValidateHook<Order> = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (operation !== 'update' || !data || !originalDoc) return data

  const key = await requestApiKey(req)
  if (key?.role !== 'site') return data

  if (originalDoc.cafe?.serviceMode) {
    throw new ValidationError({
      errors: [{ path: 'status', message: 'برای تغییر وضعیت سفارش کافه از مسیر صندوق استفاده کنید.' }],
    })
  }

  return { status: data.status ?? originalDoc.status }
}
