// @vitest-environment node
//
// The `beforeOperation` hook is the seam between the pure allowlist and the REST
// response. Its structured `APIError.data` is what lets the tenant uploader show
// the real validator reason instead of generic type/size copy.
import { describe, expect, it } from 'vitest'

import { sanitizeSvgUpload } from '@/hooks/sanitizeSvgUpload'
import { MAX_SVG_BYTES } from '@/lib/svg'

type HookArgs = Parameters<typeof sanitizeSvgUpload>[0]
type UploadedFile = {
  data: Buffer
  mimetype: string
  name: string
  size: number
}
type ApiErrorLike = {
  data?: Record<string, unknown>
  isPublic?: boolean
  message?: string
  status?: number
}

const svgFile = (source: string, name = 'logo.svg'): UploadedFile => ({
  data: Buffer.from(source, 'utf8'),
  mimetype: 'image/svg+xml',
  name,
  size: Buffer.byteLength(source),
})

const runHook = (file: UploadedFile) => {
  const req = { file }
  sanitizeSvgUpload({ args: {}, operation: 'create', req } as unknown as HookArgs)
  return req
}

const capture = (file: UploadedFile): ApiErrorLike => {
  try {
    runHook(file)
  } catch (error) {
    return error as ApiErrorLike
  }
  throw new Error('expected the upload to be refused')
}

describe('sanitizeSvgUpload — actionable API errors', () => {
  it('returns a public 400 with the rejected feature and validator reason', () => {
    const error = capture(
      svgFile(
        '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="opacity" to="1"/></svg>',
      ),
    )

    expect(error.status).toBe(400)
    expect(error.isPublic).toBe(true)
    expect(error.message).toContain('فایل SVG پذیرفته نشد')
    expect(error.data).toMatchObject({
      code: 'svg-invalid-element',
      feature: 'animate',
      validator: 'svg',
    })
    expect(error.data?.reason).toContain('animate')
    // No raw markup, stack or file contents are exposed.
    expect(error.data?.reason).not.toContain('<svg')
    expect(error.data).not.toHaveProperty('stack')
  })

  it('returns a distinct code for the exact 200 KB limit', () => {
    const bytes = Buffer.alloc(MAX_SVG_BYTES + 1, 0x61)
    const error = capture({
      data: bytes,
      mimetype: 'image/svg+xml',
      name: 'huge.svg',
      size: bytes.length,
    })

    expect(error.status).toBe(400)
    expect(error.data).toMatchObject({ code: 'svg-too-large', validator: 'svg' })
    expect(error.data?.reason).toContain('۲۰۰ کیلوبایت')
  })

  it('stores exactly the validated bytes for an accepted SVG', () => {
    const source =
      '<?xml version="1.0"?><!-- exported --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>'
    const req = runHook(svgFile(source))

    const stored = req.file.data.toString('utf8')
    expect(stored.startsWith('<svg')).toBe(true)
    expect(stored).not.toContain('<?xml')
    expect(stored).not.toContain('<!--')
    expect(req.file.mimetype).toBe('image/svg+xml')
    expect(req.file.size).toBe(Buffer.byteLength(stored))
  })

  it('leaves a real raster upload untouched', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const file: UploadedFile = { data: png, mimetype: 'image/png', name: 'logo.png', size: png.length }
    const req = runHook(file)

    expect(req.file.data).toBe(png)
    expect(req.file.mimetype).toBe('image/png')
  })
})
