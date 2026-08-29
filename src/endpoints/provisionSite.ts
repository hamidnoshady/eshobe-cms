import type { Endpoint } from 'payload'
import { APIError, ValidationError } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { provisionSite, type ProvisionSiteInput } from '@/provisioning/provisionSite'
import { siteOrigin } from '@/lib/site-url'

/**
 * The HTTP face of the one action (Wave 5): the admin view's form posts here.
 *
 * Platform-admin only — this is an agency-operated internal action, not a
 * signup funnel. It mounts under `/api`, which the control-plane host serves
 * and customer hosts 404 (see the Caddyfile), so it is unreachable from a
 * client domain even before the role check.
 */
export const provisionSiteEndpoint: Endpoint = {
  path: '/provision-site',
  method: 'post',
  handler: async (req) => {
    if (!isPlatformAdmin(req.user)) {
      return Response.json(
        { message: 'ساخت سایت فقط برای مدیر پلتفرم ممکن است.' },
        { status: 403, headers: { 'cache-control': 'no-store' } },
      )
    }

    let input: ProvisionSiteInput

    try {
      input = (await req.json?.()) as ProvisionSiteInput
    } catch {
      return Response.json(
        { message: 'بدنهٔ درخواست باید JSON باشد.' },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      )
    }

    if (!input) {
      return Response.json(
        { message: 'بدنهٔ درخواست خالی است.' },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      )
    }

    try {
      const result = await provisionSite({ input, payload: req.payload, req })

      return Response.json(
        {
          site: {
            adminUrl: `/admin/collections/sites/${result.site.id}`,
            availableLocales: result.site.availableLocales,
            defaultLocale: result.site.defaultLocale,
            domain: result.site.domain,
            id: result.site.id,
            name: result.site.name,
            type: result.site.type,
            // Absolute, on the customer's own domain — the URL the operator will
            // check next, with the deployment's own protocol and port.
            url: siteOrigin(result.site, req.origin),
          },
          summary: {
            forms: 1,
            footers: 1,
            headers: 1,
            pages: result.pages.length,
            themes: 1,
            users: result.users.length,
          },
          users: result.users,
        },
        { status: 201, headers: { 'cache-control': 'no-store' } },
      )
    } catch (error) {
      if (error instanceof ValidationError) {
        // Field-level, in Persian — the form shows these next to the inputs.
        return Response.json(
          { errors: error.data.errors, message: error.message },
          { status: error.status, headers: { 'cache-control': 'no-store' } },
        )
      }

      if (error instanceof APIError) {
        return Response.json(
          { message: error.message },
          { status: error.status, headers: { 'cache-control': 'no-store' } },
        )
      }

      req.payload.logger.error(error)

      return Response.json(
        { message: 'ساخت سایت ناموفق بود؛ همهٔ تغییرات بازگردانده شد.' },
        { status: 500, headers: { 'cache-control': 'no-store' } },
      )
    }
  },
}
