import type { PayloadRequest } from 'payload'

import { updateInfoFor } from '@/deploy/service'
import { idOf } from '@/lib/ids'
import { previewHttpsUrl } from '@/lib/deploy/previewUrl'
import { applicationHostOf, isProductionMode, needsRedeploy } from '@/lib/deploy/status'

const redeploySource = (
  site: Record<string, unknown>,
  rows: Record<string, unknown>[],
): null | Record<string, unknown> => {
  const active = idOf(site.activeDeployment)
  return (
    rows.find((row) => active && String(row.id) === active) ??
    rows.find((row) => row.status === 'live' && isProductionMode(row.domainMode)) ??
    rows.find((row) => row.status === 'live') ??
    rows.find((row) => row.status !== 'removed') ??
    null
  )
}

export type SiteDeploymentSummary = {
  activeCommit: null | string
  activePackageKey: null | string
  activePackageName: null | string
  activeStatus: null | string
  domainMode: null | string
  needsRedeploy: boolean
  previewCommit: null | string
  previewOpenUrl: null | string
  previewStatus: null | string
  renderedBy: string
  repository: null | string
  updateAvailable: boolean
  updateLatestCommit: null | string
}

const recentDeployments = async (req: PayloadRequest, siteId: string, limit = 25) => {
  const { docs } = await req.payload.find({
    collection: 'site-deployments',
    depth: 0,
    limit,
    overrideAccess: true,
    req,
    sort: '-createdAt',
    where: { site: { equals: siteId } },
  })
  return docs as unknown as Record<string, unknown>[]
}

/** Operator-facing deployment snapshot for Customer 360 — no secrets. */
export const siteDeploymentSummaryFor = async (
  req: PayloadRequest,
  site: Record<string, unknown>,
): Promise<SiteDeploymentSummary> => {
  const siteId = String(site.id)
  const docs = await recentDeployments(req, siteId)
  const source = redeploySource(site, docs)

  const productionLive =
    docs.find(
      (row) =>
        row.status === 'live' &&
        isProductionMode(row.domainMode) &&
        String(row.id) === String(idOf(site.activeDeployment)),
    ) ??
    docs.find((row) => row.status === 'live' && isProductionMode(row.domainMode)) ??
    null

  const previewLive =
    docs.find((row) => row.status === 'live' && row.domainMode === 'preview') ??
    docs.find((row) => row.domainMode === 'preview' && ['queued', 'creating', 'building', 'verifying'].includes(String(row.status))) ??
    null

  let packageDoc: null | Record<string, unknown> = null
  const themePackageId = idOf(productionLive?.themePackage ?? source?.themePackage)
  if (themePackageId) {
    packageDoc = (await req.payload.findByID({
      collection: 'theme-packages',
      depth: 0,
      disableErrors: true,
      id: themePackageId,
      overrideAccess: true,
      req,
    })) as null | Record<string, unknown>
  }

  const update = productionLive && packageDoc ? updateInfoFor(productionLive, packageDoc) : null

  const previewHost = previewLive ? applicationHostOf(previewLive) : null

  return {
    activeCommit: productionLive?.commitSha ? String(productionLive.commitSha) : null,
    activePackageKey: packageDoc ? String(packageDoc.key ?? '') : null,
    activePackageName: packageDoc ? String(packageDoc.name ?? packageDoc.key ?? '') : null,
    activeStatus: productionLive ? String(productionLive.status ?? '') : null,
    domainMode: productionLive ? String(productionLive.domainMode ?? '') : null,
    needsRedeploy: productionLive ? needsRedeploy(productionLive, site) : false,
    previewCommit: previewLive?.commitSha ? String(previewLive.commitSha) : null,
    previewOpenUrl: previewHttpsUrl(previewHost),
    previewStatus: previewLive ? String(previewLive.status ?? '') : null,
    renderedBy: String(site.renderedBy ?? 'platform'),
    repository: packageDoc?.repository ? String(packageDoc.repository) : null,
    updateAvailable: update?.updateAvailable === true,
    updateLatestCommit: update?.latestCommit ?? null,
  }
}
