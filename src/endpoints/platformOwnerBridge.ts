import type { CollectionSlug, Endpoint, PayloadRequest } from 'payload'

import { isPlatformAdminOrPlatformKey } from '@/access/siteApiKey'
import { isPlatformAdmin } from '@/access/platformAdmin'
import {
  canEditThemeSettings,
  saveThemeSettings,
  themeSettingsView,
  type SiteStaffRole,
} from '@/deploy/tenantSettings'
import { idOf, isUuid } from '@/lib/ids'

import { json, param, requireOperator, siteById } from './platformShared'

const PUBLISH_COLLECTIONS = ['posts', 'pages', 'products'] as const
type PublishCollection = (typeof PUBLISH_COLLECTIONS)[number]

const isPublishCollection = (value: string): value is PublishCollection =>
  (PUBLISH_COLLECTIONS as readonly string[]).includes(value)

const readBody = async (
  req: PayloadRequest,
): Promise<{ body?: Record<string, unknown>; error?: Response }> => {
  try {
    const parsed = (await req.json?.()) ?? {}
    if (!parsed || typeof parsed !== 'object') {
      return { error: json({ message: 'بدنهٔ درخواست باید یک شیء JSON باشد.', ok: false }, 400) }
    }
    return { body: parsed as Record<string, unknown> }
  } catch {
    return { error: json({ message: 'بدنهٔ درخواست باید JSON باشد.', ok: false }, 400) }
  }
}

const docBelongsToSite = (doc: Record<string, unknown>, siteId: string): boolean =>
  idOf(doc.site) === siteId

/** `POST /api/platform/sites/:id/publish` — platform key publishes one document. */
export const platformSitePublishEndpoint: Endpoint = {
  path: '/platform/sites/:id/publish',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const siteId = param(req, 'id')
    if (!isUuid(siteId)) return json({ message: 'شناسهٔ سایت نامعتبر است.', ok: false }, 400)

    const site = await siteById(req, siteId)
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { body, error } = await readBody(req)
    if (error) return error

    const collection = String(body?.collection ?? '')
    const docId = String(body?.id ?? '')
    if (!isPublishCollection(collection)) {
      return json({ message: 'مجموعهٔ انتشار نامعتبر است.', ok: false }, 400)
    }
    if (!isUuid(docId)) return json({ message: 'شناسهٔ سند نامعتبر است.', ok: false }, 400)

    const existing = (await req.payload.findByID({
      collection: collection as CollectionSlug,
      depth: 0,
      disableErrors: true,
      id: docId,
      overrideAccess: true,
      req,
    })) as unknown as null | Record<string, unknown>

    if (!existing || !docBelongsToSite(existing, siteId)) {
      return json({ message: 'سند متعلق به این سایت نیست.', ok: false }, 404)
    }

    await req.payload.update({
      collection: collection as CollectionSlug,
      data: { _status: 'published' },
      id: docId,
      overrideAccess: true,
      req,
    })

    return json({ collection, id: docId, ok: true })
  },
}

const platformThemeRole = async (req: PayloadRequest): Promise<SiteStaffRole | null> => {
  if (isPlatformAdmin(req.user)) return 'platform'
  if (await isPlatformAdminOrPlatformKey(req, false)) return 'platform'
  return null
}

/** `GET /api/platform/sites/:id/theme-settings` */
export const platformSiteThemeSettingsGetEndpoint: Endpoint = {
  path: '/platform/sites/:id/theme-settings',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const siteId = param(req, 'id')
    if (!isUuid(siteId)) return json({ message: 'شناسهٔ سایت نامعتبر است.', ok: false }, 400)
    if (!(await siteById(req, siteId))) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const role = await platformThemeRole(req)
    if (!role) return json({ message: 'دسترسی کافی نیست.', ok: false }, 403)

    return json({ ok: true, ...(await themeSettingsView(req, siteId, role)) })
  },
}

/** `POST /api/platform/sites/:id/theme-settings` */
export const platformSiteThemeSettingsSaveEndpoint: Endpoint = {
  path: '/platform/sites/:id/theme-settings',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const siteId = param(req, 'id')
    if (!isUuid(siteId)) return json({ message: 'شناسهٔ سایت نامعتبر است.', ok: false }, 400)
    if (!(await siteById(req, siteId))) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const role = await platformThemeRole(req)
    if (!role || !canEditThemeSettings(role)) {
      return json({ message: 'دسترسی کافی نیست.', ok: false }, 403)
    }

    const { body, error } = await readBody(req)
    if (error) return error

    const saved = await saveThemeSettings(req, siteId, { clear: body?.clear, values: body?.values })
    if (!saved.ok) {
      return json({ errors: saved.errors, message: saved.errors.join(' '), ok: false }, 400)
    }

    return json({
      message: 'تنظیمات پوسته ذخیره شد.',
      ok: true,
      ...(await themeSettingsView(req, siteId, role)),
    })
  },
}

export const platformOwnerBridgeEndpoints: Endpoint[] = [
  platformSitePublishEndpoint,
  platformSiteThemeSettingsGetEndpoint,
  platformSiteThemeSettingsSaveEndpoint,
]
