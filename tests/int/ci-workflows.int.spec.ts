// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * The delivery pipeline as a testable artefact.
 *
 * A workflow file is the one piece of this repository that nothing else
 * exercises: it only ever runs on GitHub, and it only ever runs *after* it is
 * merged. Every regression it can have is therefore discovered in production —
 * a trigger quietly removed, a job dropped out of the gate, a deploy step that
 * stops depending on the tests, a credential inlined into a public file. These
 * assertions are the cheapest place to catch all four.
 *
 * The properties pinned here are the ones the pipeline exists for:
 *   1. CI runs automatically (pull request + push to main), not only by hand.
 *   2. Every suite the repo owns is a CI job, and `ci-success` aggregates all
 *      of them — adding a job cannot silently fall outside the gate.
 *   3. The publish workflow reuses *that* CI, so "the tests pass" has exactly
 *      one definition.
 *   4. Nothing is built, pushed or deployed before CI is green, and the deploy
 *      additionally waits for the image push.
 *   5. No secret, token or production hostname is hardcoded in the workflows.
 */

type Job = {
  needs?: string | string[]
  if?: string
  steps?: { env?: Record<string, string>; run?: string; uses?: string; with?: unknown }[]
  uses?: string
  environment?: unknown
  services?: Record<string, unknown>
  [key: string]: unknown
}

type Workflow = {
  // `on:` is YAML 1.1's boolean `true` after parsing — see below.
  on?: Record<string, unknown>
  true?: Record<string, unknown>
  concurrency?: { 'cancel-in-progress'?: unknown; group?: string }
  jobs: Record<string, Job>
}

const workflow = (name: string): { raw: string; parsed: Workflow } => {
  const raw = readFileSync(resolve(process.cwd(), '.github/workflows', name), 'utf8')

  return { parsed: parse(raw) as Workflow, raw }
}

const ci = workflow('ci.yml')
const publish = workflow('publish.yml')

/**
 * YAML 1.1 resolves the bare key `on` to the boolean `true`, which is exactly
 * why GitHub's own schema tolerates both. Read it back the same way rather than
 * quoting the key in the file and diverging from every other Actions workflow.
 */
const triggers = (w: Workflow): Record<string, unknown> =>
  (w.on ?? w.true ?? {}) as Record<string, unknown>

const needsOf = (job: Job): string[] =>
  Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : []

describe('CI workflow triggers', () => {
  it('runs automatically on pull requests, and is callable by publish.yml', () => {
    const on = triggers(ci.parsed)

    // The whole point of the change: a branch is checked by CI itself, not by
    // trusting that somebody ran the checklist locally before pushing.
    expect(Object.keys(on)).toEqual(
      expect.arrayContaining(['pull_request', 'workflow_dispatch', 'workflow_call']),
    )
  })

  it('does not also run on push to main, which would duplicate the whole suite', () => {
    // `main` is covered on every merge because publish.yml's gate *is* this
    // workflow. A push trigger here would run two Postgres services, a Docker
    // build and Playwright a second time on the same commit for no new signal.
    expect(triggers(ci.parsed)).not.toHaveProperty('push')
    expect(publish.parsed.jobs.ci.uses).toBe('./.github/workflows/ci.yml')
  })

  it('supersedes a superseded pull request but never a run on main', () => {
    // A force-push during review should cancel the stale run; a run on `main`
    // must not be cancellable, because publish.yml is waiting on its result.
    expect(ci.parsed.concurrency?.['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' }}",
    )
    expect(ci.parsed.concurrency?.group).toContain('github.event.pull_request.number')
  })
})

describe('CI covers every suite the repository owns', () => {
  const jobs = ci.parsed.jobs

  it('has a job for each of lint, typecheck, build, docker, integration and e2e', () => {
    expect(Object.keys(jobs).sort()).toEqual(
      ['build', 'ci-success', 'docker-build', 'lint', 'test-int', 'test-e2e', 'typecheck'].sort(),
    )
  })

  it.each([
    ['lint', 'pnpm lint'],
    ['typecheck', 'pnpm typecheck'],
    ['build', 'pnpm build'],
    ['test-int', 'pnpm test:int'],
    ['test-e2e', 'pnpm test:e2e'],
  ])('%s runs %s', (job, command) => {
    const commands = (jobs[job].steps ?? []).map((step) => step.run ?? '')
    expect(commands.some((run) => run.includes(command))).toBe(true)
  })

  it('runs the deployment suites that live outside vitest', () => {
    // These two are the migration/ownership story — the part of the system that
    // only fails on a real deploy. They are separate steps on purpose (see the
    // header of tests/int/migrations.int.spec.ts) and both must stay in CI.
    const docker = (jobs['docker-build'].steps ?? []).map((step) => step.run ?? '')
    expect(docker.some((run) => run.includes('tests/deployment/compose-smoke.sh'))).toBe(true)

    const int = (jobs['test-int'].steps ?? []).map((step) => step.run ?? '')
    expect(int.some((run) => run.includes('tests/deployment/ownership.ts'))).toBe(true)
  })

  it.each(['test-int', 'test-e2e'])('gives %s a real Postgres service', (job) => {
    expect(jobs[job].services).toHaveProperty('postgres')
  })

  it('gates the whole run on one aggregate job that lists every other job', () => {
    const gate = jobs['ci-success']
    const others = Object.keys(jobs).filter((name) => name !== 'ci-success')

    // If a future job is added and forgotten here, this fails — which is the
    // only reason a single aggregate check is safe to require in branch
    // protection.
    expect(needsOf(gate).sort()).toEqual(others.sort())
    expect(gate.if).toBe('always()')
  })

  it('treats a skipped or cancelled dependency as a failure, not a pass', () => {
    // `needs: [...]` alone would let a cancelled job through when the gate is
    // `if: always()`; the result of each dependency has to be inspected.
    const run = (ci.parsed.jobs['ci-success'].steps ?? []).map((step) => step.run ?? '').join('\n')
    expect(run).toContain('join(needs.*.result')
    expect(run).toContain('!= success')
    expect(run).toContain('exit 1')
  })
})

describe('the workflow files parse as GitHub Actions, not merely as YAML', () => {
  it.each([
    ['ci.yml', ci.raw],
    ['publish.yml', publish.raw],
  ])('%s uses single quotes inside every ${{ }} expression', (_name, raw) => {
    // GitHub's expression syntax has NO double-quoted string literal. A `" "`
    // inside `${{ }}` is not a warning and not a runtime error — the workflow
    // file fails to parse, and the run appears in the Actions tab with zero
    // jobs and the message "This run likely failed because of a workflow file
    // issue", which names neither the file nor the line. Every YAML parser and
    // JSON-schema validator accepts it happily, so this is the only cheap place
    // to catch it. It cost a red run on `join(needs.*.result, " ")`.
    const expressions = raw.match(/\$\{\{[^}]*\}\}/g) ?? []
    expect(expressions.length).toBeGreaterThan(0)
    for (const expression of expressions) expect(expression).not.toContain('"')
  })

  it.each([
    ['ci.yml', ci.raw],
    ['publish.yml', publish.raw],
  ])('%s closes every expression it opens, on the same line', (_name, raw) => {
    // Counting `${{` against every `}}` in the file would be wrong: the
    // docker/metadata-action tag list legitimately contains its own
    // `{{is_default_branch}}` / `{{version}}` templates, which are not GitHub
    // expressions. Check each opener finds a closer on its own line instead.
    const openers = raw.split('\n').filter((line) => line.includes('${{'))
    expect(openers.length).toBeGreaterThan(0)
    for (const line of openers) {
      expect(line.slice(line.indexOf('${{') + 3), `unclosed expression: ${line.trim()}`).toContain(
        '}}',
      )
    }
  })
})

describe('publishing and deploying are gated on that same CI', () => {
  const jobs = publish.parsed.jobs

  it('still publishes automatically on every push to main', () => {
    // Deployment consumes `:latest`. A manual-only publish means a merge
    // changes nothing in production while appearing to have shipped.
    const on = triggers(publish.parsed)
    expect((on.push as { branches: string[] }).branches).toEqual(['main'])
    expect(on).toHaveProperty('workflow_dispatch')
  })

  it('calls the CI workflow itself rather than re-implementing its checks', () => {
    // One definition of "the tests pass". A copied-out lint/typecheck/build
    // job is what previously let a red integration suite reach production.
    expect(jobs.ci.uses).toBe('./.github/workflows/ci.yml')
  })

  it('builds and pushes the image only after CI succeeds', () => {
    expect(needsOf(jobs['docker-publish'])).toContain('ci')
  })

  it('deploys only after both CI and the image push', () => {
    expect(needsOf(jobs.deploy).sort()).toEqual(['ci', 'docker-publish'])
  })

  it('never deploys from a branch or a dispatch that is not main or a release tag', () => {
    expect(jobs.deploy.if).toBe(
      "github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')",
    )
  })

  it('runs the deploy through a GitHub Environment so approval/secrets can be required', () => {
    expect((jobs.deploy.environment as { name: string }).name).toBe('production')
  })

  it('verifies the rollout with the shared script instead of a fire-and-forget curl', () => {
    const steps = jobs.deploy.steps ?? []
    const deployStep = steps.find((step) => (step.run ?? '').includes('coolify-deploy.sh'))
    expect(deployStep, 'deploy job must call scripts/coolify-deploy.sh').toBeDefined()

    // The regression being pinned: a raw `curl` whose exit status says only that
    // Coolify accepted the request, not that the deployment finished.
    const runs = steps.map((step) => step.run ?? '').join('\n')
    expect(runs).not.toMatch(/curl[^\n]*coolify|curl[^\n]*api\/v1/i)
  })

  it('passes every Coolify input from repository variables or secrets', () => {
    const env = (publish.parsed.jobs.deploy.steps ?? []).find((step) =>
      (step.run ?? '').includes('coolify-deploy.sh'),
    )?.env

    expect(env?.COOLIFY_URL).toContain('vars.COOLIFY_URL')
    expect(env?.COOLIFY_API_TOKEN).toContain('secrets.COOLIFY_API_TOKEN')
    expect(env?.COOLIFY_RESOURCE_UUID).toContain('COOLIFY_RESOURCE_UUID')
    expect(env?.COOLIFY_HEALTHCHECK_URL).toContain('vars.COOLIFY_HEALTHCHECK_URL')
  })
})

describe('no production identifiers or credentials are committed in the workflows', () => {
  it.each([
    ['ci.yml', ci.raw],
    ['publish.yml', publish.raw],
  ])('%s hardcodes no Coolify host, UUID or token', (_name, raw) => {
    // The previous deploy step embedded both the manage.eshobe.com host and the
    // literal service UUID. Neither is a secret in the cryptographic sense, and
    // both are a free map of the production control plane in a public repo.
    expect(raw).not.toMatch(/manage\.eshobe\.com/)
    expect(raw).not.toMatch(/ltabipqxfaajai7jeuc3g5eb/)

    // A bearer token may only ever appear as a secrets reference.
    const bearers = raw.match(/Bearer [^\s"']+/g) ?? []
    for (const bearer of bearers) expect(bearer).toContain('secrets.')
  })

  it.each([
    ['ci.yml', ci.parsed],
    ['publish.yml', publish.parsed],
  ])('%s grants no more than read access by default', (_name, parsed) => {
    expect((parsed as unknown as { permissions: unknown }).permissions).toEqual({
      contents: 'read',
    })
  })
})
