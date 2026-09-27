import { DOMAIN_MODES, type DomainMode } from '@/lib/deploy/status'

export const DEPLOYMENT_LANES = ['preview', 'production'] as const
export type DeploymentLane = (typeof DEPLOYMENT_LANES)[number]

export const DEPLOYMENT_LANE_LABELS: Record<DeploymentLane, string> = {
  preview: 'پیش‌نمایش',
  production: 'انتشار روی دامنه',
}

export const isDeploymentLane = (value: unknown): value is DeploymentLane =>
  typeof value === 'string' && (DEPLOYMENT_LANES as readonly string[]).includes(value)

/** Read `ESHOBE_LEGACY_CADDY_EDGE` per call — not at module load. */
export const legacyCaddyEdgeEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  String(env.ESHOBE_LEGACY_CADDY_EDGE ?? '').trim() === '1'

export const laneFromDomainMode = (mode: unknown): DeploymentLane =>
  mode === 'preview' ? 'preview' : 'production'

export const domainModeForLane = (
  lane: DeploymentLane,
  explicitMode?: unknown,
): DomainMode => {
  if (lane === 'preview') return 'preview'
  if (explicitMode === 'edge' && legacyCaddyEdgeEnabled()) return 'edge'
  if (explicitMode === 'edge' || explicitMode === 'direct') {
    return explicitMode as DomainMode
  }
  return 'direct'
}

export const resolveDeployMode = (input: {
  domainMode?: unknown
  lane?: unknown
}): { domainMode: DomainMode; lane: DeploymentLane } | { message: string; ok: false } => {
  if (isDeploymentLane(input.lane)) {
    const lane = input.lane
    if (lane === 'production' && input.domainMode === 'edge' && !legacyCaddyEdgeEnabled()) {
      return {
        message:
          'حالت Caddy (edge) در این محیط غیرفعال است. برای انتشار روی دامنه از lane=production استفاده کنید.',
        ok: false,
      }
    }
    const domainMode = domainModeForLane(lane, input.domainMode)
    if (domainMode === 'edge' && !legacyCaddyEdgeEnabled()) {
      return { message: 'استقرار edge جدید پذیرفته نمی‌شود.', ok: false }
    }
    return { domainMode, lane }
  }

  const raw = input.domainMode
  if (typeof raw === 'string' && (DOMAIN_MODES as readonly string[]).includes(raw)) {
    const domainMode = raw as DomainMode
    if (domainMode === 'edge' && !legacyCaddyEdgeEnabled()) {
      return {
        message:
          'استقرار edge جدید پذیرفته نمی‌شود. از lane=production یا domainMode=direct استفاده کنید.',
        ok: false,
      }
    }
    return { domainMode, lane: laneFromDomainMode(domainMode) }
  }

  return { domainMode: 'preview', lane: 'preview' }
}
