/**
 * Boot-time checks for the values that are only wrong in production, and only
 * silently.
 *
 * A short or placeholder `PAYLOAD_SECRET` is not a warning-level problem: it signs
 * every session cookie and encrypts every stored credential, so a guessable one is a
 * platform-wide admin account for anybody who tries the obvious strings — across
 * *every* tenant. The same secret also has to survive a restart: regenerate it and
 * every editor is logged out and every encrypted field is unreadable.
 *
 * These run at init, not at import, and never during `next build` — the production
 * image builds with deliberate placeholder values (there is no database or secret at
 * build time), and failing that build is not the point.
 */

const PLACEHOLDERS = [
  'build-time-placeholder',
  'changeme',
  'secret',
  'your_cron_secret_here',
  'your_secret_here',
]

/** 32 characters of `openssl rand -base64 48` output; anything shorter is a typo. */
const MIN_LENGTH = { CRON_SECRET: 16, PAYLOAD_SECRET: 32, PREVIEW_SECRET: 16 }

type Env = Record<string, string | undefined>

const problemsFor = (name: keyof typeof MIN_LENGTH, value: string | undefined): string[] => {
  if (!value) return [`${name} is not set.`]

  if (PLACEHOLDERS.includes(value.trim().toLowerCase()))
    return [`${name} is still the example placeholder.`]

  if (value.trim().length < MIN_LENGTH[name])
    return [`${name} is shorter than ${MIN_LENGTH[name]} characters.`]

  return []
}

/**
 * Every reason this environment must not serve production traffic, as sentences.
 * Pure and exported so the rule set is testable without a running app.
 */
export const productionEnvProblems = (env: Env): string[] => [
  ...problemsFor('PAYLOAD_SECRET', env.PAYLOAD_SECRET),
  ...problemsFor('CRON_SECRET', env.CRON_SECRET),
  ...problemsFor('PREVIEW_SECRET', env.PREVIEW_SECRET),
  ...(env.NEXT_PUBLIC_SERVER_URL?.startsWith('https://')
    ? []
    : ['NEXT_PUBLIC_SERVER_URL is not an https:// URL.']),
]

/**
 * `next build` sets `NODE_ENV=production` and, in our Dockerfile, dummy secrets — so
 * the phase, not the mode, is what says whether this is a real boot.
 */
export const shouldCheckEnv = (env: Env): boolean =>
  env.NODE_ENV === 'production' && env.NEXT_PHASE !== 'phase-production-build'

/**
 * Throws rather than warns. A container that refuses to start is a deploy that
 * fails loudly; a warning in a log nobody reads is a platform running on
 * `YOUR_SECRET_HERE`.
 */
export const assertProductionEnv = (env: Env = process.env): void => {
  if (!shouldCheckEnv(env)) return

  const problems = productionEnvProblems(env)

  if (!problems.length) return

  throw new Error(
    [
      'Refusing to start in production with an unsafe environment:',
      ...problems.map((problem) => `  - ${problem}`),
      '',
      'Generate secrets with: openssl rand -base64 48',
    ].join('\n'),
  )
}

/**
 * Whether this process should run the jobs queue itself.
 *
 * `autoRun` puts the cron *inside the web container*. That is right for one VPS
 * replica and wrong in two situations, both of which duplicate or drop scheduled
 * publishes rather than erroring:
 *
 * - **Serverless.** There is no long-lived process to hold a cron.
 * - **More than one web replica.** Every replica runs the same cron against the same
 *   queue. The upgrade path is `JOBS_AUTORUN=false` on the web service plus one
 *   `payload jobs:run` container.
 *
 * Off in dev and tests unless asked for: a cron ticking every minute inside
 * `pnpm dev` writes to the same database the tests assert against.
 */
export const jobsAutoRunEnabled = (env: Env = process.env): boolean => {
  if (env.JOBS_AUTORUN === 'true') return true
  if (env.JOBS_AUTORUN === 'false') return false

  return env.NODE_ENV === 'production'
}
