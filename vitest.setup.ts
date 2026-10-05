// Any setup scripts you might need go here

// Load .env files
import 'dotenv/config'

// Dev-machine deploy overrides (local Coolify) must not change what the suite asserts.
delete process.env.DEPLOY_CMS_URL
delete process.env.DEPLOY_PUBLIC_SCHEME
process.env.DEPLOY_HEALTH_RETRY_MS = "0"
// No cross-tick grace: a probe that is still not answering fails the row at once, as it
// did before the deadline existed. Tests that exercise the deadline set it themselves.
process.env.DEPLOY_HEALTH_DEADLINE_MS = "0"
