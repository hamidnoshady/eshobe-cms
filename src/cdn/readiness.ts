import type { CdnHealthVerdict } from './probe'
import type { CdnSyncResult } from './types'

/**
 * Deployment readiness gate.
 *
 * A site is not "live" until the CDN desired state has been applied and both
 * the origin and the public CDN path answer correctly. This gate combines the
 * sync result (did the provider apply the desired state?) with the probe
 * verdict (are origin and public paths healthy, with a real certificate?) and
 * returns a single ready/blocked decision with the specific reasons.
 *
 * It is the natural join of the two halves of the epic: sync alone cannot tell
 * you whether the public hostname actually resolves and serves (graphitearc.com
 * answered 200 locally while the CDN path returned 504), and the probe alone
 * cannot tell you whether the desired state was ever applied.
 */
export type ReadinessStatus = 'healthy' | 'unhealthy'

export interface DeploymentReadiness {
  originStatus: ReadinessStatus
  publicStatus: ReadinessStatus
  ready: boolean
  reasons: string[]
  syncOk: boolean
  syncSummary: string
}

const syncSummary = (sync: CdnSyncResult): string => {
  const blocked = sync.actions.filter((action) => action.state === 'blocked')
  return blocked.length === 0
    ? `Sync applied ${sync.actions.length} action(s).`
    : `Sync blocked ${blocked.length} action(s); the desired state was not fully applied.`
}

export const evaluateDeploymentReadiness = (
  sync: CdnSyncResult,
  verdict: CdnHealthVerdict,
): DeploymentReadiness => {
  const reasons: string[] = []
  const blocked = sync.actions.filter((action) => action.state === 'blocked')

  if (blocked.length > 0) {
    reasons.push(
      `CDN sync did not apply the desired state (${blocked.length} action(s) blocked)`,
    )
  }
  if (!verdict.originHealthy) {
    reasons.push('Origin is unreachable or serving an invalid certificate')
  }
  if (!verdict.publicHealthy) {
    reasons.push('Public CDN path is not healthy')
  }
  if (verdict.originHealthy && verdict.publicHealthy && !verdict.live) {
    reasons.push('A default certificate is served on the origin')
  }

  return {
    originStatus: verdict.originHealthy ? 'healthy' : 'unhealthy',
    publicStatus: verdict.publicHealthy ? 'healthy' : 'unhealthy',
    ready: reasons.length === 0,
    reasons,
    syncOk: blocked.length === 0,
    syncSummary: syncSummary(sync),
  }
}
