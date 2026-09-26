import type { PayloadRequest } from 'payload'

import { THEME_PACKAGE_SYNC_CONTEXT_KEY } from '@/collections/ThemePackages'
import { fetchThemeManifest } from '@/deploy/github'
import { isSafeGitRef } from '@/lib/deploy/manifest'
import { emitPlatformEvent } from '@/platform/webhooks'

export type ThemePackageSyncResult =
  | { commit: null | string; ok: true; ref: string }
  | { errors: string[]; message: string; ok: false }

/**
 * The only writer of manifest-derived fields on a theme package.
 *
 * Used by the operator sync button and by the GitHub push webhook. A failed sync
 * records the error and leaves the previous manifest in place.
 */
export const syncThemePackage = async (
  req: PayloadRequest,
  pkg: Record<string, unknown>,
  requestedRef: string,
  meta?: { auto?: boolean; deliveryId?: null | string },
): Promise<ThemePackageSyncResult> => {
  const id = String(pkg.id ?? '')
  if (!id) return { errors: ['شناسهٔ پوسته نامعتبر است.'], message: 'شناسهٔ پوسته نامعتبر است.', ok: false }

  if (!isSafeGitRef(requestedRef)) {
    return { errors: ['نام شاخه یا تگ نامعتبر است.'], message: 'نام شاخه یا تگ نامعتبر است.', ok: false }
  }

  const result = await fetchThemeManifest(String(pkg.repository ?? ''), requestedRef)

  const webhookMeta = meta?.auto
    ? {
        githubLastAutoSyncAt: new Date().toISOString(),
        githubLastAutoSyncError: null as null | string,
        githubLastDeliveryId: meta.deliveryId ?? null,
        githubWebhookReceivedAt: new Date().toISOString(),
      }
    : {}

  if (!result.ok) {
    const message = result.errors.join('\n')
    await req.payload.update({
      collection: 'theme-packages',
      data: {
        syncError: message,
        ...(meta?.auto
          ? {
              githubLastAutoSyncAt: new Date().toISOString(),
              githubLastAutoSyncError: message,
              githubLastDeliveryId: meta.deliveryId ?? null,
              githubWebhookReceivedAt: new Date().toISOString(),
            }
          : {}),
      },
      depth: 0,
      id,
      overrideAccess: true,
      req,
    })
    return { errors: result.errors, message: result.errors[0] ?? message, ok: false }
  }

  const { manifest } = result

  await req.payload.update({
    collection: 'theme-packages',
    context: { [THEME_PACKAGE_SYNC_CONTEXT_KEY]: true },
    data: {
      buildPack: manifest.build.buildPack,
      contractVersion: manifest.contractVersion,
      defaultRef: requestedRef,
      envSchema: manifest.env,
      healthCheckPath: manifest.build.healthCheckPath,
      manifest: manifest as unknown as Record<string, unknown>,
      manifestSyncedAt: new Date().toISOString(),
      port: manifest.build.port,
      proxiesApi: manifest.proxiesApi,
      siteTypes: manifest.siteTypes,
      syncedCommitSha: result.sha,
      syncError: null,
      ...webhookMeta,
    },
    depth: 0,
    id,
    overrideAccess: true,
    req,
  })

  await emitPlatformEvent(req, {
    data: {
      auto: meta?.auto === true,
      commit: result.sha,
      key: String(pkg.key ?? ''),
      ref: requestedRef,
    },
    event: 'plugin.changed',
    message: meta?.auto
      ? `مانیفست پوستهٔ «${String(pkg.name ?? '')}» از رویداد گیت‌هاب (${requestedRef}) به‌روز شد.`
      : `مانیفست پوستهٔ «${String(pkg.name ?? '')}» از ${requestedRef} خوانده شد.`,
    targetCollection: 'theme-packages',
    targetId: id,
  })

  return { commit: result.sha, ok: true, ref: requestedRef }
}

/** `refs/heads/main` → `main` */
export const refFromGithubPush = (ref: string): null | string => {
  const trimmed = ref.trim()
  if (trimmed.startsWith('refs/heads/')) return trimmed.slice('refs/heads/'.length)
  if (trimmed.startsWith('refs/tags/')) return trimmed.slice('refs/tags/'.length)
  return null
}
