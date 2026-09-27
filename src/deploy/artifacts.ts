import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PayloadRequest } from 'payload'

import { idOf } from '@/lib/ids'
import { parseRepository, isSafeGitRef } from '@/lib/deploy/manifest'

export const COMMIT_PATTERN = /^[0-9a-f]{40}$/i
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i
export const GHCR_IMAGE_PATTERN =
  /^ghcr\.io\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/i

export const verifyArtifactSignature = (
  secret: string,
  raw: string,
  supplied: null | string,
): boolean => {
  if (!supplied?.startsWith('sha256=')) return false
  const expected = `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`
  const a = Buffer.from(expected)
  const b = Buffer.from(supplied)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type ArtifactRegistration = {
  repository: string
  ref: string
  commit: string
  registry: 'ghcr'
  image: string
  tag?: string
  digest: string
  workflowRunId?: string
  workflowRunUrl?: string
  platform?: string
  provenanceAvailable?: boolean
  sbomAvailable?: boolean
}

export const normalizeArtifactRegistration = (
  pkg: Record<string, unknown>,
  body: Record<string, unknown>,
): { ok: true; value: ArtifactRegistration } | { ok: false; message: string } => {
  const repository = String(body.repository ?? '').trim()
  const ref = String(body.ref ?? '').trim()
  const commit = String(body.commit ?? '')
    .trim()
    .toLowerCase()
  const registry = String(body.registry ?? '')
    .trim()
    .toLowerCase()
  const image = String(body.image ?? '')
    .trim()
    .toLowerCase()
    .replace(/@sha256:.+$/, '')
    .replace(/:[^/]+$/, '')
  const digest = String(body.digest ?? '')
    .trim()
    .toLowerCase()
  const expectedRepository = String(pkg.repository ?? '')
    .trim()
    .toLowerCase()
  const expectedImage = String(pkg.registryImageRepository ?? '')
    .trim()
    .toLowerCase()

  if (!parseRepository(repository) || repository.toLowerCase() !== expectedRepository) {
    return { ok: false, message: 'مخزن callback با مخزن پوسته یکسان نیست.' }
  }
  if (!isSafeGitRef(ref)) return { ok: false, message: 'ref نامعتبر است.' }
  if (!COMMIT_PATTERN.test(commit)) return { ok: false, message: 'کامیت نامعتبر است.' }
  if (registry !== 'ghcr') return { ok: false, message: 'فقط GHCR پشتیبانی می‌شود.' }
  if (!GHCR_IMAGE_PATTERN.test(image) || !expectedImage || image !== expectedImage) {
    return { ok: false, message: 'مخزن تصویر با مخزن مجاز پوسته یکسان نیست.' }
  }
  if (!DIGEST_PATTERN.test(digest)) return { ok: false, message: 'digest نامعتبر است.' }
  const workflowRunUrl = body.workflowRunUrl ? String(body.workflowRunUrl) : undefined
  if (workflowRunUrl) {
    try {
      const url = new URL(workflowRunUrl)
      if (url.protocol !== 'https:' || url.hostname !== 'github.com') throw new Error('unsafe')
    } catch {
      return { ok: false, message: 'نشانی workflow باید HTTPS روی github.com باشد.' }
    }
  }
  return {
    ok: true,
    value: {
      repository,
      ref,
      commit,
      registry: 'ghcr',
      image,
      digest,
      tag: body.tag ? String(body.tag).slice(0, 200) : undefined,
      workflowRunId: body.workflowRunId ? String(body.workflowRunId).slice(0, 100) : undefined,
      workflowRunUrl,
      platform: body.platform ? String(body.platform).slice(0, 100) : undefined,
      provenanceAvailable: body.provenanceAvailable === true,
      sbomAvailable: body.sbomAvailable === true,
    },
  }
}

export const readyArtifactForCommit = async (
  req: PayloadRequest,
  packageId: string,
  commitSha: string,
): Promise<null | Record<string, unknown>> => {
  const { docs } = await req.payload.find({
    collection: 'theme-artifacts',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    sort: '-buildFinishedAt',
    where: {
      and: [
        { themePackage: { equals: packageId } },
        { commitSha: { equals: commitSha.toLowerCase() } },
        { status: { equals: 'ready' } },
      ],
    },
  })
  return (docs[0] as unknown as Record<string, unknown> | undefined) ?? null
}

export const artifactByIdForPackage = async (
  req: PayloadRequest,
  artifactId: string,
  packageId: string,
): Promise<null | Record<string, unknown>> => {
  const doc = await req.payload.findByID({
    collection: 'theme-artifacts',
    depth: 0,
    disableErrors: true,
    id: artifactId,
    overrideAccess: true,
    req,
  })
  const row = doc as unknown as null | Record<string, unknown>
  return row && idOf(row.themePackage) === packageId && row.status === 'ready' ? row : null
}
