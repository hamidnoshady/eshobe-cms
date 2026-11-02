import type { CollectionBeforeOperationHook } from 'payload'

import { APIError } from 'payload'

import { looksLikeSvg, validateSvgUpload } from '@/lib/svg'

/**
 * Runs before Payload looks at an upload, so the bytes it type-checks, stores and serves
 * are the bytes `validateSvgUpload` accepted — never the browser's original.
 *
 * A non-SVG upload is passed through untouched (Payload's content sniff still guards it).
 * An SVG that uses anything outside the drawing vocabulary is refused with the reason in
 * Persian. The same reason goes into `APIError.data` as a stable `code` plus the rejected
 * tag/attribute token, so the tenant uploader can show a localized, actionable message
 * instead of guessing from a generic "check the type and size" string. Only validator-
 * generated text is exposed: no raw markup, values, stack traces or secrets.
 */
export const sanitizeSvgUpload: CollectionBeforeOperationHook = ({ args, operation, req }) => {
  if (operation !== 'create' && operation !== 'update') return args
  const file = req.file
  if (!file || !looksLikeSvg(file)) return args

  const result = validateSvgUpload(file.data)
  if (!result.ok) {
    throw new APIError(
      `فایل SVG پذیرفته نشد: ${result.reason}`,
      400,
      {
        code: result.code,
        reason: result.reason,
        validator: 'svg',
        ...(result.feature ? { feature: result.feature } : {}),
      },
      true,
    )
  }

  const data = Buffer.from(result.svg, 'utf8')
  req.file = { ...file, data, mimetype: 'image/svg+xml', size: data.length }
  return args
}
