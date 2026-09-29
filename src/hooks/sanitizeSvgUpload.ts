import type { CollectionBeforeOperationHook } from 'payload'

import { APIError } from 'payload'

import { looksLikeSvg, validateSvgUpload } from '@/lib/svg'

/**
 * Runs before Payload looks at an upload, so the bytes it type-checks, stores and serves
 * are the bytes `validateSvgUpload` accepted — never the browser's original.
 *
 * A non-SVG upload is passed through untouched (Payload's content sniff still guards it).
 * An SVG that uses anything outside the drawing vocabulary is refused with the reason in
 * Persian, so the customer can re-export instead of guessing.
 */
export const sanitizeSvgUpload: CollectionBeforeOperationHook = ({ args, operation, req }) => {
  if (operation !== 'create' && operation !== 'update') return args
  const file = req.file
  if (!file || !looksLikeSvg(file)) return args

  const result = validateSvgUpload(file.data)
  if (!result.ok) throw new APIError(`فایل SVG پذیرفته نشد: ${result.reason}`, 400, undefined, true)

  const data = Buffer.from(result.svg, 'utf8')
  req.file = { ...file, data, mimetype: 'image/svg+xml', size: data.length }
  return args
}
