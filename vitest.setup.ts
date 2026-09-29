// Any setup scripts you might need go here

// Load .env files
import 'dotenv/config'

// Dev-machine deploy overrides (local Coolify) must not change what the suite asserts.
delete process.env.DEPLOY_CMS_URL
delete process.env.DEPLOY_PUBLIC_SCHEME
process.env.DEPLOY_HEALTH_RETRY_MS = "0"
