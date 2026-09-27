import type { Endpoint, PayloadRequest } from 'payload'

import { normalizeArtifactRegistration, verifyArtifactSignature } from '@/deploy/artifacts'
import { isUuid } from '@/lib/ids'
import { scrubDetail } from '@/deploy/coolify'
import { emitPlatformEvent } from '@/platform/webhooks'
import { json, param, requireOperator } from './platformShared'

const rawBody = async (req: PayloadRequest): Promise<null | string> => {
  const request = req as PayloadRequest & { text?: () => Promise<string> }
  try {
    return typeof request.text === 'function' ? await request.text() : null
  } catch {
    return null
  }
}

/** Signed, idempotent CI callback. It accepts only the package's configured repo/image. */
export const themeArtifactRegistrationEndpoint: Endpoint = {
  path: '/platform/theme-packages/:id/artifacts',
  method: 'post',
  handler: async (req) => {
    // HMAC callbacks do not use an Eshobe bearer token. If one is supplied, still
    // enforce the platform boundary so a site-scoped key cannot probe this route.
    if (req.headers.get('authorization')) {
      const denied = await requireOperator(req)
      if (denied) return denied
    }
    const secret = process.env.ESHOBE_THEME_ARTIFACT_SECRET?.trim()
    if (!secret) return json({ ok: false, message: 'ثبت آرتیفکت روی سرور پیکربندی نشده است.' }, 503)
    const raw = await rawBody(req)
    if (!raw) return json({ ok: false, message: 'بدنهٔ درخواست خوانده نشد.' }, 400)
    if (!verifyArtifactSignature(secret, raw, req.headers.get('x-eshobe-signature-256'))) {
      return json({ ok: false, message: 'امضای callback نامعتبر است.' }, 401)
    }
    const packageId = param(req, 'id')
    if (!isUuid(packageId)) return json({ ok: false, message: 'شناسهٔ پوسته نامعتبر است.' }, 400)
    const pkg = (await req.payload.findByID({
      collection: 'theme-packages',
      depth: 0,
      disableErrors: true,
      id: packageId,
      overrideAccess: true,
      req,
    })) as null | Record<string, unknown>
    if (!pkg) return json({ ok: false, message: 'پوسته پیدا نشد.' }, 404)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return json({ ok: false, message: 'JSON نامعتبر است.' }, 400)
    }
    const normalized = normalizeArtifactRegistration(pkg, body)
    if (!normalized.ok) return json({ ok: false, message: normalized.message }, 422)
    const value = normalized.value
    const immutableKey = `${packageId}:${value.commit}:${value.digest}`
    const existing = await req.payload.find({
      collection: 'theme-artifacts',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { immutableKey: { equals: immutableKey } },
    })
    if (existing.docs[0])
      return json({ artifact: String(existing.docs[0].id), duplicate: true, ok: true })

    try {
      const artifact = await req.payload.create({
        collection: 'theme-artifacts',
        overrideAccess: true,
        req,
        depth: 0,
        data: {
          immutableKey,
          themePackage: packageId,
          source: 'github_actions',
          repository: value.repository,
          ref: value.ref,
          commitSha: value.commit,
          registryProvider: 'ghcr',
          imageRepository: value.image,
          imageTag: value.tag,
          imageDigest: value.digest,
          immutableImage: `${value.image}@${value.digest}`,
          platform: value.platform,
          status: 'ready',
          workflowRunId: value.workflowRunId,
          workflowRunUrl: value.workflowRunUrl,
          provenanceAvailable: value.provenanceAvailable,
          sbomAvailable: value.sbomAvailable,
          buildFinishedAt: new Date().toISOString(),
        },
      })
      await emitPlatformEvent(req, {
        data: {
          artifact: String(artifact.id),
          commit: value.commit,
          digest: value.digest,
          package: packageId,
        },
        event: 'theme.artifact.ready',
        message: `آرتیفکت immutable پوسته آماده شد (${value.commit.slice(0, 7)}).`,
        targetCollection: 'theme-artifacts',
        targetId: String(artifact.id),
      })
      return json({ artifact: String(artifact.id), duplicate: false, ok: true }, 201)
    } catch (error) {
      // A concurrent callback may have won the unique key race.
      const found = await req.payload.find({
        collection: 'theme-artifacts',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        req,
        where: { immutableKey: { equals: immutableKey } },
      })
      if (found.docs[0])
        return json({ artifact: String(found.docs[0].id), duplicate: true, ok: true })
      req.payload.logger.error({
        msg: 'artifact registration failed',
        detail: scrubDetail((error as Error).message),
      })
      return json({ ok: false, message: 'ثبت آرتیفکت ناموفق بود.' }, 500)
    }
  },
}
