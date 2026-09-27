import { describe, expect, it } from 'vitest'

import { latestPackageCommit, updateInfoFor } from '@/deploy/service'

const oldCommit = 'a'.repeat(40)
const newCommit = 'b'.repeat(40)
const oldDigest = `sha256:${'c'.repeat(64)}`
const newDigest = `sha256:${'d'.repeat(64)}`

describe('deployment update detection', () => {
  it('keeps source-build commit comparison compatible', () => {
    expect(
      updateInfoFor({ commitSha: oldCommit }, { defaultRef: 'main', syncedCommitSha: newCommit })
        .deployableUpdateAvailable,
    ).toBe(true)
    expect(
      updateInfoFor({ commitSha: newCommit }, { defaultRef: 'main', syncedCommitSha: newCommit })
        .updateAvailable,
    ).toBe(false)
  })

  it('distinguishes a detected source commit from a deployable image', () => {
    const update = updateInfoFor(
      { commitSha: oldCommit, imageDigest: oldDigest },
      { defaultRef: 'main', syncedCommitSha: newCommit, deploymentStrategy: 'registry_image' },
    )
    expect(update).toMatchObject({
      sourceUpdateAvailable: true,
      artifactReady: false,
      deployableUpdateAvailable: false,
    })
  })

  it('reports a ready digest only when it differs from the deployed digest', () => {
    const pkg = {
      defaultRef: 'main',
      syncedCommitSha: newCommit,
      deploymentStrategy: 'registry_image',
    }
    const artifact = {
      id: 'artifact-2',
      commitSha: newCommit,
      imageDigest: newDigest,
      status: 'ready',
    }
    expect(
      updateInfoFor({ commitSha: oldCommit, imageDigest: oldDigest }, pkg, artifact),
    ).toMatchObject({
      artifactReady: true,
      deployableUpdateAvailable: true,
      latestDigest: newDigest,
    })
    expect(
      updateInfoFor({ commitSha: newCommit, imageDigest: newDigest }, pkg, artifact)
        .updateAvailable,
    ).toBe(false)
  })

  it('honours pinnedCommit over a newer synced commit', () => {
    expect(latestPackageCommit({ pinnedCommit: oldCommit, syncedCommitSha: newCommit })).toBe(
      oldCommit,
    )
  })
})
