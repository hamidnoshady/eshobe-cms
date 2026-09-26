import type { CollectionBeforeValidateHook } from 'payload'

import { APIError } from 'payload'

/**
 * Plans, subscriptions and invoices are a read-only archive of the period when
 * this CMS kept its own commercial ledger. Nothing in the application sets the
 * context flag, including `overrideAccess` writers: a local script must not be
 * able to open a second subscription engine.
 */
export const LEGACY_COMMERCIAL_WRITE = 'allowLegacyCommercialWrite'

export const freezeCommercialWrites: CollectionBeforeValidateHook = ({ req }) => {
  if (req?.context?.[LEGACY_COMMERCIAL_WRITE] === true) return
  throw new APIError(
    'طرح، اشتراک و صورتحساب در اشوب‌سی‌ام‌اس فقط بایگانی است. تصمیم تجاری در پلتفرم اشوب گرفته می‌شود.',
    403,
  )
}
