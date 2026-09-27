import type { Endpoint, PayloadRequest } from 'payload'

import {
  canEditThemeSettings,
  saveThemeSettings,
  siteStaffRole,
  themeSettingsView,
  type SiteStaffRole,
} from '@/deploy/tenantSettings'
import { isUuid } from '@/lib/ids'

import { json, search } from './platformShared'

/**
 * `GET|POST /api/site-theme-settings/current?site=<id>` — a site's own staff reading
 * and answering the variables their deployable theme asks for.
 *
 * Collection endpoints on `site-theme-settings`, not top-level ones: Payload
 * dispatches `/api/<collection-slug>/…` to that collection and never falls back to
 * `config.endpoints` (CLAUDE.md, the `api-keys/issue` lesson).
 *
 * ## The boundary
 *
 * An admin **session** only — a site key is a site's integration credential, not a
 * person on its staff, and it gets 403 here. The session must belong to a member of
 * the named site (or platform staff); the `site` parameter only *chooses among* the
 * sites the caller already belongs to, so naming another customer's site id is a 403,
 * not a read. Owners may write; editors may read. The package comes from the site's
 * deployments, never from the request.
 *
 * No Caddy carve-out: this is the admin's own API, reached on the control-plane host.
 */

const resolve = async (
  req: PayloadRequest,
  siteId: string,
): Promise<{ error: Response; role?: never } | { error?: never; role: SiteStaffRole }> => {
  if (!isUuid(siteId)) {
    return { error: json({ message: 'شناسهٔ سایت نامعتبر است.', ok: false }, 400) }
  }
  const role = siteStaffRole(req.user, siteId)
  if (!role) {
    return { error: json({ message: 'به تنظیمات پوستهٔ این سایت دسترسی ندارید.', ok: false }, 403) }
  }
  return { role }
}

export const themeSettingsGetEndpoint: Endpoint = {
  path: '/current',
  method: 'get',
  handler: async (req) => {
    const siteId = search(req).get('site') ?? ''
    const { error, role } = await resolve(req, siteId)
    if (error) return error

    return json({ ok: true, ...(await themeSettingsView(req, siteId, role)) })
  },
}

export const themeSettingsSaveEndpoint: Endpoint = {
  path: '/current',
  method: 'post',
  handler: async (req) => {
    let body: Record<string, unknown>
    try {
      const parsed = (await req.json?.()) ?? {}
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
      body = parsed as Record<string, unknown>
    } catch {
      return json({ message: 'بدنهٔ درخواست باید یک شیء JSON باشد.', ok: false }, 400)
    }

    const siteId = String(body.site ?? search(req).get('site') ?? '')
    const { error, role } = await resolve(req, siteId)
    if (error) return error

    if (!canEditThemeSettings(role)) {
      return json({ message: 'فقط مالک سایت می‌تواند تنظیمات پوسته را تغییر دهد.', ok: false }, 403)
    }

    const saved = await saveThemeSettings(req, siteId, {
      bindings: body.bindings,
      clear: body.clear,
      runtimeSettings: body.runtimeSettings,
      values: body.values,
    })
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
