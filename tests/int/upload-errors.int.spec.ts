// @vitest-environment node
//
// Pure response parsing. Node's global `Response` is what the browser fetch gives
// the uploader; jsdom does not provide it, and no Payload server is needed here.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  networkUploadError,
  parseUploadError,
  unexpectedUploadError,
  uploadErrorMessage,
  type UploadErrorInfo,
} from '@/admin/fields/uploadErrors'

const errorResponse = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  })

const svgError = (
  code: string,
  feature: string,
  reason: string,
): Response =>
  errorResponse(400, {
    errors: [
      {
        data: { code, feature, reason, validator: 'svg' },
        message: `فایل SVG پذیرفته نشد: ${reason}`,
        name: 'APIError',
      },
    ],
  })

describe('parseUploadError', () => {
  it('surfaces a safe validator reason and the rejected feature from HTTP 400', async () => {
    const info = await parseUploadError(
      svgError('svg-invalid-element', 'feImage', 'عنصر «feImage» در SVG مجاز نیست.'),
    )

    expect(info.kind).toBe('svg-feature')
    expect(info.code).toBe('svg-invalid-element')
    expect(info.feature).toBe('feImage')
    expect(info.reason).toContain('feImage')
    expect(info.status).toBe(400)
  })

  it('separates the exact 200 KB SVG limit from other refusals', async () => {
    const info = await parseUploadError(
      svgError('svg-too-large', '', 'فایل SVG بزرگتر از ۲۰۰ کیلوبایت است.'),
    )

    expect(info.kind).toBe('svg-size')
    expect(uploadErrorMessage(info, 'huge.svg', true)).toContain('۲۰۰ کیلوبایت')
    expect(uploadErrorMessage(info, 'huge.svg', false)).toContain('200 KB')
  })

  it.each([
    [402, { errors: [{ message: 'سهمیهٔ رسانه تمام شده است.' }] }, 'quota'],
    [401, { errors: [{ message: 'Unauthorized' }] }, 'auth'],
    [403, { errors: [{ message: 'Forbidden' }] }, 'auth'],
    [413, { errors: [{ message: 'Payload too large' }] }, 'file-size'],
    [400, { errors: [{ message: "Invalid file type: 'application/pdf'" }] }, 'mime'],
    [400, { errors: [{ message: 'File type text/html (from extension html) is not allowed.' }] }, 'mime'],
    [500, { errors: [{ message: 'Something went wrong.' }] }, 'storage'],
    [503, '<html>storage is down</html>', 'storage'],
    [400, { errors: [{ message: 'The following field is invalid: file' }] }, 'validation'],
    [404, { errors: [{ message: 'Not found' }] }, 'unexpected'],
  ])('categorizes HTTP %i as %s', async (status, body, kind) => {
    const info = await parseUploadError(errorResponse(status, body))
    expect(info.kind).toBe(kind)
  })

  it('never trusts an SVG-shaped code from a response that is not our validator', async () => {
    const info = await parseUploadError(
      errorResponse(400, {
        errors: [
          {
            data: {
              code: 'svg-invalid-element',
              feature: 'filter',
              reason: '<script>secret</script>',
            },
            message: 'The following field is invalid: file',
          },
        ],
      }),
    )

    expect(info.kind).toBe('validation')
    expect(info.reason).toBeUndefined()
    expect(info.feature).toBeUndefined()
  })
})

describe('uploadErrorMessage', () => {
  it('shows the real validator reason and the failing filename, not generic type/size copy', () => {
    const info: UploadErrorInfo = {
      code: 'svg-invalid-attribute',
      feature: 'onload',
      kind: 'svg-feature',
      reason: 'ویژگی «onload» در SVG مجاز نیست.',
    }
    const message = uploadErrorMessage(info, 'Graphite_Logo(2).svg', true)

    expect(message).toContain('onload')
    expect(message).toContain('Graphite_Logo(2).svg')
    expect(message).not.toContain('نوع و اندازهٔ فایل')
  })

  it('localizes the same reason for an English admin', () => {
    const info: UploadErrorInfo = {
      code: 'svg-invalid-element',
      feature: 'animate',
      kind: 'svg-feature',
      reason: 'عنصر «animate» در SVG مجاز نیست.',
    }
    const message = uploadErrorMessage(info, 'logo.svg', false)

    expect(message).toContain('animate')
    expect(message).toContain('SVG upload rejected')
    expect(message).not.toContain('مجاز نیست')
  })

  it('strips markup, control characters and stack traces from server text', () => {
    const info: UploadErrorInfo = {
      kind: 'validation',
      message: '<script>alert(1)</script>\nError: secret\n  at /srv/app.js:1:1',
    }
    const message = uploadErrorMessage(info, 'bad<script>.svg', true)

    expect(message).not.toContain('<script>')
    expect(message).not.toContain('secret')
    expect(message).not.toContain('/srv/app.js')
  })

  it('has distinct copy for permissions, storage, network and unexpected failures', () => {
    const messages = [
      uploadErrorMessage({ kind: 'auth' }, '', true),
      uploadErrorMessage({ kind: 'storage' }, '', true),
      uploadErrorMessage(networkUploadError(), '', true),
      uploadErrorMessage(unexpectedUploadError(), '', true),
      uploadErrorMessage({ kind: 'quota' }, '', true),
      uploadErrorMessage({ kind: 'mime' }, '', true),
      uploadErrorMessage({ kind: 'file-size' }, '', true),
    ]
    expect(new Set(messages).size).toBe(messages.length)
  })
})

describe('tenant uploader wiring', () => {
  it('parses the API response per filename instead of showing the generic catch-all', () => {
    const source = readFileSync(
      new URL('../../src/admin/fields/TenantMediaUploadField.tsx', import.meta.url),
      'utf8',
    )

    expect(source).toContain('failUpload(await parseUploadError(response), file.name)')
    expect(source).toContain('uploadErrorMessage(')
    expect(source).toContain('failure.filename')
    expect(source).not.toContain('بارگذاری انجام نشد. نوع و اندازهٔ فایل را بررسی کنید.')
  })
})
