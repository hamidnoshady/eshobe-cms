import { describe, expect, it } from 'vitest'

import { placementForLane, resolveDeploymentPlan } from '@/deploy/plan'

const sha = 'a'.repeat(40)
const digest = `sha256:${'b'.repeat(64)}`
const pkg = {
  repository: 'owner/theme',
  visibility: 'public',
  deploymentStrategy: 'coolify_build',
  buildPack: 'nixpacks',
  defaultRef: 'main',
  registryImageRepository: 'ghcr.io/owner/theme',
  registryVisibility: 'public',
}
const target = {
  defaultServerUuid: 'server-default',
  previewProjectUuid: 'project-preview',
  previewEnvironmentName: 'preview',
  productionProjectUuid: 'project-production',
  productionEnvironmentName: 'production',
  publicGitEnabled: true,
  publicRegistryPullEnabled: true,
}

const resolve = (
  overrides: Record<string, unknown> = {},
  targetOverrides: Record<string, unknown> = {},
  lane: 'preview' | 'production' = 'preview',
) =>
  resolveDeploymentPlan({
    themePackage: { ...pkg, ...overrides },
    artifact:
      overrides.deploymentStrategy === 'registry_image'
        ? { status: 'ready', imageRepository: 'ghcr.io/owner/theme', imageDigest: digest }
        : null,
    deployTarget: { ...target, ...targetOverrides },
    lane,
    branch: 'main',
    commitSha: sha,
  })

describe('deployment plan resolver', () => {
  it.each(['preview', 'production'] as const)('resolves public Git for %s', (lane) => {
    const result = resolve({}, {}, lane)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.source.type).toBe('git')
      expect(result.plan.access.gitMethod).toBe('public')
      expect(result.plan.placement.environmentName).toBe(lane)
    }
  })

  it('prefers GitHub App then falls back to deploy key for private Git', () => {
    const app = resolve(
      { visibility: 'private' },
      { githubAppEnabled: true, githubAppUuid: 'app-1' },
    )
    expect(app.ok && app.plan.access.gitMethod).toBe('github-app')
    const key = resolve(
      { visibility: 'private' },
      { deployKeyEnabled: true, privateKeyUuid: 'key-1' },
    )
    expect(key.ok && key.plan.access.gitMethod).toBe('deploy-key')
  })

  it('refuses private Git without infrastructure credentials', () => {
    expect(resolve({ visibility: 'private' })).toMatchObject({ ok: false })
  })

  it('resolves public and private immutable GHCR independently of repository visibility', () => {
    const publicImage = resolve({ deploymentStrategy: 'registry_image', visibility: 'private' })
    expect(publicImage.ok && publicImage.plan.source).toEqual({
      type: 'registry-image',
      image: 'ghcr.io/owner/theme',
      digest,
    })
    const privateImage = resolve(
      { deploymentStrategy: 'registry_image', registryVisibility: 'private' },
      { ghcrEnabled: true, ghcrCredentialUuid: 'registry-1' },
    )
    expect(privateImage.ok && privateImage.plan.access.registryCredentialUuid).toBe('registry-1')
  })

  it('refuses mutable/unready images and missing private credentials', () => {
    const bad = resolveDeploymentPlan({
      themePackage: { ...pkg, deploymentStrategy: 'registry_image' },
      artifact: { status: 'building', imageRepository: 'ghcr.io/owner/theme', imageDigest: digest },
      deployTarget: target,
      lane: 'preview',
    })
    expect(bad.ok).toBe(false)
    expect(
      resolve({ deploymentStrategy: 'registry_image', registryVisibility: 'private' }).ok,
    ).toBe(false)
  })

  it('supports same project/different environments, different projects and different servers', () => {
    expect(
      placementForLane(
        { ...target, previewProjectUuid: 'same', productionProjectUuid: 'same' },
        'preview',
      ),
    ).toMatchObject({ projectUuid: 'same', environmentName: 'preview' })
    expect(placementForLane(target, 'production').projectUuid).toBe('project-production')
    expect(
      placementForLane({ ...target, productionServerUuid: 'server-2' }, 'production').serverUuid,
    ).toBe('server-2')
    expect(placementForLane(target, 'preview').serverUuid).toBe('server-default')
  })

  it('keeps a binding pinned after target edits', () => {
    const result = resolve(
      {},
      { previewProjectUuid: 'new-project', defaultServerUuid: 'new-server' },
    )
    const pinned = resolveDeploymentPlan({
      themePackage: pkg,
      deployTarget: { ...target, previewProjectUuid: 'new-project' },
      lane: 'preview',
      binding: {
        coolifyProjectUuid: 'old-project',
        serverUuid: 'old-server',
        environmentName: 'old-env',
      },
    })
    expect(result.ok).toBe(true)
    expect(pinned.ok && pinned.plan.placement).toEqual({
      projectUuid: 'old-project',
      serverUuid: 'old-server',
      environmentName: 'old-env',
    })
  })
})
