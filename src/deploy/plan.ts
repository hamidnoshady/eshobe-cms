import type { BuildPack } from '@/lib/deploy/manifest'
import type { DeploymentLane } from '@/lib/deploy/lane'

export type DeploymentStrategy = 'coolify_build' | 'registry_image'

export type GitDeploymentSource = {
  type: 'git'
  repository: string
  branch: string
  commitSha?: string
  buildPack: BuildPack
}

export type RegistryDeploymentSource = {
  type: 'registry-image'
  image: string
  digest: string
}

export type DeploymentSource = GitDeploymentSource | RegistryDeploymentSource

export type DeploymentPlan = {
  strategy: DeploymentStrategy
  source: DeploymentSource
  placement: {
    serverUuid: string
    projectUuid: string
    environmentName: string
  }
  access: {
    gitMethod?: 'public' | 'github-app' | 'deploy-key'
    githubAppUuid?: string
    privateKeyUuid?: string
    registryCredentialUuid?: string
  }
}

type PlanInput = {
  themePackage: Record<string, unknown>
  artifact?: null | Record<string, unknown>
  deployTarget: Record<string, unknown>
  lane: DeploymentLane
  binding?: null | Record<string, unknown>
  branch?: string
  commitSha?: null | string
}

export type PlanResult = { ok: true; plan: DeploymentPlan } | { ok: false; message: string }

const text = (value: unknown): string => String(value ?? '').trim()
const enabled = (value: unknown, fallback = false): boolean =>
  typeof value === 'boolean' ? value : fallback

/** Resolve new placement fields with a deliberate fallback to the Wave 11 columns. */
export const placementForLane = (
  target: Record<string, unknown>,
  lane: DeploymentLane,
): DeploymentPlan['placement'] => {
  const prefix = lane === 'preview' ? 'preview' : 'production'
  return {
    serverUuid:
      text(target[`${prefix}ServerUuid`]) ||
      text(target.defaultServerUuid) ||
      text(target.serverUuid),
    projectUuid:
      text(target[`${prefix}ProjectUuid`]) ||
      (lane === 'production' ? text(target.projectUuid) : ''),
    environmentName:
      text(target[`${prefix}EnvironmentName`]) || text(target.environmentName) || 'production',
  }
}

/**
 * The only policy decision point for source type, visibility, credentials and lane
 * placement. It is side-effect free so API handlers, jobs and self-tests cannot drift.
 */
export const resolveDeploymentPlan = (input: PlanInput): PlanResult => {
  const { artifact, binding, deployTarget: target, lane, themePackage: pkg } = input
  const strategy = (text(pkg.deploymentStrategy) || 'coolify_build') as DeploymentStrategy
  if (strategy !== 'coolify_build' && strategy !== 'registry_image') {
    return { ok: false, message: 'روش استقرار پوسته پشتیبانی نمی‌شود.' }
  }

  const resolved = placementForLane(target, lane)
  const placement = binding
    ? {
        serverUuid: text(binding.serverUuid) || resolved.serverUuid,
        projectUuid: text(binding.coolifyProjectUuid) || resolved.projectUuid,
        environmentName: text(binding.environmentName) || resolved.environmentName,
      }
    : resolved

  if (!placement.serverUuid)
    return { ok: false, message: 'سرور Coolify برای این مسیر مشخص نشده است.' }
  if (!placement.projectUuid)
    return { ok: false, message: 'پروژهٔ Coolify برای این مسیر مشخص نشده است.' }
  if (!placement.environmentName)
    return { ok: false, message: 'محیط Coolify برای این مسیر مشخص نشده است.' }

  if (strategy === 'registry_image') {
    if (!artifact || artifact.status !== 'ready') {
      return { ok: false, message: 'برای این کامیت هنوز تصویر آماده و تأییدشده‌ای وجود ندارد.' }
    }
    const image = text(artifact.imageRepository)
    const digest = text(artifact.imageDigest).toLowerCase()
    const allowed = text(pkg.registryImageRepository).toLowerCase()
    if (!image || image.toLowerCase() !== allowed || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      return { ok: false, message: 'هویت تصویر immutable نامعتبر یا خارج از مخزن مجاز پوسته است.' }
    }
    const privateImage = text(pkg.registryVisibility) === 'private'
    const credential = text(target.ghcrCredentialUuid)
    if (privateImage && (!enabled(target.ghcrEnabled) || !credential)) {
      return { ok: false, message: 'اعتبارنامهٔ GHCR خصوصی روی سرور استقرار تنظیم نشده است.' }
    }
    if (!privateImage && !enabled(target.publicRegistryPullEnabled, true)) {
      return { ok: false, message: 'کشیدن تصویر عمومی روی این سرور غیرفعال است.' }
    }
    return {
      ok: true,
      plan: {
        strategy,
        source: { type: 'registry-image', image, digest },
        placement,
        access: privateImage ? { registryCredentialUuid: credential } : {},
      },
    }
  }

  const repository = text(pkg.repository)
  const isPrivate = text(pkg.visibility ?? pkg.repositoryVisibility) === 'private'
  let access: DeploymentPlan['access']
  if (!isPrivate) {
    if (!enabled(target.publicGitEnabled, true)) {
      return { ok: false, message: 'دسترسی به مخزن عمومی روی این سرور غیرفعال است.' }
    }
    access = { gitMethod: 'public' }
  } else if (
    enabled(target.githubAppEnabled, text(target.gitSource) === 'githubApp') &&
    text(target.githubAppUuid)
  ) {
    access = { gitMethod: 'github-app', githubAppUuid: text(target.githubAppUuid) }
  } else if (
    enabled(target.deployKeyEnabled, text(target.gitSource) === 'deployKey') &&
    text(target.privateKeyUuid)
  ) {
    access = { gitMethod: 'deploy-key', privateKeyUuid: text(target.privateKeyUuid) }
  } else {
    return {
      ok: false,
      message: 'برای مخزن خصوصی GitHub App یا deploy key قابل استفاده تنظیم نشده است.',
    }
  }

  const buildPack = text(pkg.buildPack) as BuildPack
  if (!repository || !buildPack)
    return { ok: false, message: 'مخزن یا build pack پوسته کامل نیست.' }
  return {
    ok: true,
    plan: {
      strategy,
      source: {
        type: 'git',
        repository,
        branch: input.branch || text(pkg.defaultRef) || 'main',
        ...(input.commitSha ? { commitSha: input.commitSha } : {}),
        buildPack,
      },
      placement,
      access,
    },
  }
}
