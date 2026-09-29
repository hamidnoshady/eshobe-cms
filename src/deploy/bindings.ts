import type { PayloadRequest } from 'payload'

import { idOf, isUuid } from '@/lib/ids'
import type { DeploymentLane } from '@/lib/deploy/lane'
import { bindingAppName, bindingKeyOf, legacyAppName } from '@/lib/deploy/appIdentity'
import type { DomainMode } from '@/lib/deploy/status'
import { laneFromDomainMode } from '@/lib/deploy/lane'
import { placementForLane } from './plan'

import { CoolifyClient, type DeployTarget, targetPinnedToBinding } from './coolify'

export type ThemeBindingRow = Record<string, unknown>

export const infrastructureFromTarget = (
  targetDoc: Record<string, unknown>,
  lane: DeploymentLane,
): {
  coolifyProjectUuid: string
  environmentName: string
  serverUuid: string
  targetId: string
} => {
  const placement = placementForLane(targetDoc, lane)
  return {
    coolifyProjectUuid: placement.projectUuid,
    environmentName: placement.environmentName,
    serverUuid: placement.serverUuid,
    targetId: String(targetDoc.id),
  }
}

export const findBindingByKey = async (
  req: PayloadRequest,
  bindingKey: string,
): Promise<null | ThemeBindingRow> => {
  const { docs } = await req.payload.find({
    collection: 'theme-bindings',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { bindingKey: { equals: bindingKey } },
  })
  return (docs[0] as unknown as ThemeBindingRow) ?? null
}

export type EnsureBindingInput = {
  applicationHostname: null | string
  domainMode: DomainMode
  lane: DeploymentLane
  req: PayloadRequest
  site: Record<string, unknown>
  siteId: string
  targetDoc: Record<string, unknown>
  themeKey: string
  themePackageId: string
}

export type EnsureBindingResult =
  | { binding: ThemeBindingRow; ok: true }
  | { message: string; ok: false }

/**
 * Return the single binding for (site, package, lane), creating it if needed.
 * Target defaults apply only on first create; later target changes on the deploy-target
 * row do not move the binding.
 */
export const ensureThemeBinding = async (
  input: EnsureBindingInput,
): Promise<EnsureBindingResult> => {
  const { lane, req, siteId, targetDoc, themeKey, themePackageId } = input
  const bindingKey = bindingKeyOf(siteId, themePackageId, lane)
  const requestedTargetId = String(targetDoc.id)
  const infra = infrastructureFromTarget(targetDoc, lane)
  const appName = bindingAppName(siteId, themeKey, lane)

  let binding = await findBindingByKey(req, bindingKey)

  if (binding) {
    if (binding.state === 'conflict') {
      return {
        message:
          String(binding.conflictDetail ?? '') ||
          'اتصال پوسته در وضعیت تعارض است؛ قبل از استقرار، تعارض را در پنل برطرف کنید.',
        ok: false,
      }
    }

    const boundTarget = idOf(binding.target)
    if (boundTarget && boundTarget !== requestedTargetId) {
      return {
        message:
          'این سایت برای این پوسته و مسیر قبلاً روی سرور دیگری متصل شده است. جابه‌جایی سرور به‌صورت خودکار انجام نمی‌شود.',
        ok: false,
      }
    }

    if (!binding.appName) {
      binding = (await req.payload.update({
        collection: 'theme-bindings',
        data: { appName },
        depth: 0,
        id: String(binding.id),
        overrideAccess: true,
        req,
      })) as unknown as ThemeBindingRow
    }

    return { binding, ok: true }
  }

  const created = await req.payload.create({
    collection: 'theme-bindings',
    data: {
      appName,
      applicationHostname: input.applicationHostname,
      bindingKey,
      coolifyProjectUuid: infra.coolifyProjectUuid,
      environmentName: infra.environmentName,
      lane,
      serverUuid: infra.serverUuid,
      site: siteId,
      state: 'active',
      target: requestedTargetId,
      themePackage: themePackageId,
    },
    depth: 0,
    overrideAccess: true,
    req,
  })

  return { binding: created as unknown as ThemeBindingRow, ok: true }
}

export const claimBindingProvisioning = async (
  req: PayloadRequest,
  bindingId: string,
  deploymentId: string,
): Promise<boolean> => {
  if (!isUuid(bindingId)) return false

  const { docs } = await req.payload.update({
    collection: 'theme-bindings',
    data: { provisioningDeployment: deploymentId, state: 'provisioning' },
    depth: 0,
    overrideAccess: true,
    req,
    where: {
      and: [
        { id: { equals: bindingId } },
        {
          or: [
            { state: { equals: 'active' } },
            {
              and: [
                { state: { equals: 'provisioning' } },
                { provisioningDeployment: { equals: deploymentId } },
              ],
            },
          ],
        },
      ],
    },
  })

  return docs.length > 0
}

export const releaseBindingProvisioning = async (
  req: PayloadRequest,
  bindingId: string,
  patch: Record<string, unknown> = {},
): Promise<void> => {
  if (!isUuid(bindingId)) return
  await req.payload.update({
    collection: 'theme-bindings',
    data: {
      ...patch,
      provisioningDeployment: undefined,
      state: (patch.state as 'active' | undefined) ?? 'active',
    },
    depth: 0,
    id: bindingId,
    overrideAccess: true,
    req,
  })
}

export const persistBindingApp = async (
  req: PayloadRequest,
  bindingId: string,
  data: {
    appUuid: string
    applicationHostname?: null | string
  },
): Promise<void> => {
  await releaseBindingProvisioning(req, bindingId, {
    appUuid: data.appUuid,
    ...(data.applicationHostname ? { applicationHostname: data.applicationHostname } : {}),
  })
}

/** Resolve app UUID: binding → legacy name in pinned project → create path. */
export const resolveBindingAppUuid = async (
  req: PayloadRequest,
  input: {
    binding: ThemeBindingRow
    client: CoolifyClient
    domainMode: DomainMode
    site: Record<string, unknown>
    themeKey: string
  },
): Promise<
  | { appUuid: string; ok: true; source: 'binding' | 'legacy' | 'lookup' }
  | { message: string; ok: false }
> => {
  const row = input.binding
  const existing = row.appUuid ? String(row.appUuid) : ''
  if (existing) return { appUuid: existing, ok: true, source: 'binding' }

  const appName = String(
    row.appName ??
      bindingAppName(String(idOf(row.site)), input.themeKey, String(row.lane) as DeploymentLane),
  )

  const scoped = await input.client.findApplicationScoped({
    name: appName,
    projectUuid: String(row.coolifyProjectUuid ?? ''),
    serverUuid: String(row.serverUuid ?? ''),
  })
  if (!scoped.ok) return { message: scoped.message, ok: false }
  if (scoped.data) return { appUuid: scoped.data.uuid, ok: true, source: 'lookup' }

  const legacyName = legacyAppName(
    String(input.site.domain ?? ''),
    String(input.site.id),
    input.themeKey,
    input.domainMode,
  )
  if (legacyName !== appName) {
    const legacy = await input.client.findApplicationScoped({
      name: legacyName,
      projectUuid: String(row.coolifyProjectUuid ?? ''),
      serverUuid: String(row.serverUuid ?? ''),
    })
    if (!legacy.ok) return { message: legacy.message, ok: false }
    if (legacy.data) return { appUuid: legacy.data.uuid, ok: true, source: 'legacy' }
  }

  return { appUuid: '', ok: true, source: 'lookup' }
}

export const markBindingConflict = async (
  req: PayloadRequest,
  bindingId: string,
  detail: string,
): Promise<void> => {
  await req.payload.update({
    collection: 'theme-bindings',
    data: { conflictDetail: detail, state: 'conflict' },
    depth: 0,
    id: bindingId,
    overrideAccess: true,
    req,
  })
}

export const laneForDeployment = (deployment: Record<string, unknown>): DeploymentLane => {
  const lane = deployment.lane
  if (lane === 'preview' || lane === 'production') return lane
  return laneFromDomainMode(deployment.domainMode)
}

export const coolifyTargetForBinding = (
  base: DeployTarget,
  binding: ThemeBindingRow,
): DeployTarget => targetPinnedToBinding(base, binding)

export const backfillBindingFromDeployment = async (
  req: PayloadRequest,
  deployment: Record<string, unknown>,
  targetDoc: Record<string, unknown>,
  themeKey: string,
): Promise<null | ThemeBindingRow> => {
  const siteId = idOf(deployment.site)
  const themePackageId = idOf(deployment.themePackage)
  if (!siteId || !themePackageId) return null

  const lane = laneForDeployment(deployment)
  const bindingKey = bindingKeyOf(siteId, themePackageId, lane)
  const existing = await findBindingByKey(req, bindingKey)
  if (existing) return existing

  const infra = infrastructureFromTarget(targetDoc, lane)
  const appUuid = deployment.appUuid ? String(deployment.appUuid) : null

  return (await req.payload.create({
    collection: 'theme-bindings',
    data: {
      appName: bindingAppName(siteId, themeKey, lane),
      appUuid,
      applicationHostname: deployment.previewDomain ? String(deployment.previewDomain) : null,
      bindingKey,
      coolifyProjectUuid: infra.coolifyProjectUuid,
      environmentName: infra.environmentName,
      lane,
      serverUuid: infra.serverUuid,
      site: siteId,
      state: 'active',
      target: infra.targetId,
      themePackage: themePackageId,
    },
    depth: 0,
    overrideAccess: true,
    req,
  })) as unknown as ThemeBindingRow
}
