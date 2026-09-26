import { createHmac, timingSafeEqual } from 'node:crypto'

import type { Endpoint, PayloadRequest } from 'payload'

import { refFromGithubPush, syncThemePackage } from '@/deploy/themePackageSync'
import { parseRepository } from '@/lib/deploy/manifest'

import { json, requireOperator } from './platformShared'

const SIGNATURE_HEADER = 'x-hub-signature-256'
const DELIVERY_HEADER = 'x-github-delivery'
const EVENT_HEADER = 'x-github-event'

type PushPayload = {
  after?: string
  ref?: string
  repository?: { full_name?: string; name?: string; owner?: { login?: string } }
}

const verifyGithubSignature = (secret: string, rawBody: string, header: null | string): boolean => {
  if (!header?.startsWith('sha256=')) return false
  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const expected = `sha256=${digest}`
  try {
    const a = Buffer.from(expected)
    const b = Buffer.from(header)
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

const readRawBody = async (req: PayloadRequest): Promise<null | string> => {
  const asRequest = req as PayloadRequest & { text?: () => Promise<string> }
  if (typeof asRequest.text === 'function') {
    try {
      return await asRequest.text()
    } catch {
      return null
    }
  }
  return null
}

/**
 * `POST /api/platform/theme-packages/github-webhook` — GitHub `push` events.
 *
 * Control-plane only (no Caddy carve-out on customer domains). When
 * `GITHUB_THEME_WEBHOOK_SECRET` is unset, the route answers 503 so a webhook URL
 * cannot be registered against an open endpoint.
 *
 * Matching packages by `repository` (`owner/name`), syncing only when the pushed ref
 * equals the package's `defaultRef`. Does not deploy any site — only refreshes
 * manifest metadata and `syncedCommitSha`, which drives «نسخهٔ جدید موجود است».
 */
export const themeGithubWebhookEndpoint: Endpoint = {
  path: '/platform/theme-packages/github-webhook',
  method: 'post',
  handler: async (req) => {
    const isGithub = Boolean(req.headers.get(EVENT_HEADER))
    if (!isGithub) {
      const denied = await requireOperator(req)
      if (denied) return denied
    }

    const secret = process.env.GITHUB_THEME_WEBHOOK_SECRET?.trim()
    if (!secret) {
      return json(
        {
          message:
            'رویداد گیت‌هاب غیرفعال است؛ متغیر GITHUB_THEME_WEBHOOK_SECRET را در سرور تنظیم کنید.',
          ok: false,
        },
        503,
      )
    }

    const raw = await readRawBody(req)
    if (!raw) {
      return json({ message: 'بدنهٔ درخواست خوانده نشد.', ok: false }, 400)
    }

    const signature = req.headers.get(SIGNATURE_HEADER)
    if (!verifyGithubSignature(secret, raw, signature)) {
      return json({ message: 'امضای گیت‌هاب نامعتبر است.', ok: false }, 401)
    }

    const event = req.headers.get(EVENT_HEADER)
    if (event !== 'push') {
      return json({ ok: true, skipped: true, reason: 'event' })
    }

    let payload: PushPayload
    try {
      payload = JSON.parse(raw) as PushPayload
    } catch {
      return json({ message: 'بدنهٔ JSON نامعتبر است.', ok: false }, 400)
    }

    const fullName = String(payload.repository?.full_name ?? '').trim()
    if (!fullName || !parseRepository(fullName)) {
      return json({ ok: true, skipped: true, reason: 'repository' })
    }

    const pushedRef = refFromGithubPush(String(payload.ref ?? ''))
    if (!pushedRef) {
      return json({ ok: true, skipped: true, reason: 'ref' })
    }

    const deliveryId = req.headers.get(DELIVERY_HEADER)

    const { docs } = await req.payload.find({
      collection: 'theme-packages',
      depth: 0,
      limit: 50,
      overrideAccess: true,
      pagination: false,
      req,
      where: { repository: { equals: fullName } },
    })

    if (!docs.length) {
      return json({ ok: true, matched: 0, skipped: true, reason: 'no-package' })
    }

    const results: { id: string; key: string; result: 'duplicate' | 'ref-mismatch' | 'synced' | 'sync-failed' }[] =
      []

    for (const doc of docs as unknown as Record<string, unknown>[]) {
      const id = String(doc.id)
      const key = String(doc.key ?? '')
      const defaultRef = String(doc.defaultRef ?? 'main')

      if (pushedRef !== defaultRef) {
        results.push({ id, key, result: 'ref-mismatch' })
        continue
      }

      if (deliveryId && doc.githubLastDeliveryId === deliveryId) {
        results.push({ id, key, result: 'duplicate' })
        continue
      }

      const result = await syncThemePackage(req, doc, defaultRef, {
        auto: true,
        deliveryId,
      })
      results.push({ id, key, result: result.ok ? 'synced' : 'sync-failed' })
    }

    return json({
      matched: docs.length,
      ok: true,
      pushedRef,
      repository: fullName,
      results,
    })
  },
}
