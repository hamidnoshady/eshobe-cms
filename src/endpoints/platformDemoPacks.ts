import type { Endpoint } from 'payload'

import { applyDemoPack, listDemoPacks } from '@/platform/demoPacks'

import { json, param, requireOperator, siteById } from './platformShared'

/**
 * Demo packs (`demo-packs/<key>/`): `GET /api/platform/demo-packs` lists them,
 * `POST /api/platform/sites/:id/demo-pack { pack, dryRun? }` imports one into a site.
 * Platform admin or platform key only — same boundary as the snapshot pair, and like
 * it deliberately without a Caddy carve-out.
 */
export const demoPacksListEndpoint: Endpoint = {
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    return json({ ok: true, packs: await listDemoPacks() })
  },
  method: 'get',
  path: '/platform/demo-packs',
}

export const demoPackImportEndpoint: Endpoint = {
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const body = (await req.json?.().catch(() => null)) as null | { dryRun?: unknown; pack?: unknown }
    if (!body || typeof body.pack !== 'string') {
      return json({ message: 'کلید بستهٔ نمونه (pack) ارسال نشده است.', ok: false }, 400)
    }

    const dryRun = body.dryRun === true
    const result = await applyDemoPack(req, site, body.pack, dryRun)
    if (!result.ok) {
      return json(
        {
          message:
            result.reason === 'type_mismatch'
              ? 'نوع این سایت با نوع بستهٔ نمونه یکی نیست.'
              : 'بستهٔ نمونه پیدا نشد.',
          ok: false,
          reason: result.reason,
        },
        result.reason === 'type_mismatch' ? 409 : 404,
      )
    }

    const { categories, media, pages, posts, skipped } = result.summary
    return json({
      dryRun,
      message: `${dryRun ? 'پیش‌نمایش: ' : 'انجام شد: '}${pages} صفحه، ${categories} دسته، ${posts} نوشته و ${media} تصویر ${dryRun ? 'ساخته می‌شود' : 'ساخته شد'}؛ ${skipped} مورد از قبل وجود داشت.`,
      ok: true,
      summary: result.summary,
    })
  },
  method: 'post',
  path: '/platform/sites/:id/demo-pack',
}

export const platformDemoPackEndpoints: Endpoint[] = [demoPacksListEndpoint, demoPackImportEndpoint]
