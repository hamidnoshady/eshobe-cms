/**
 * Dev seed: `pnpm seed`. Wraps the template's own seed so it runs without an
 * admin session — the /next/seed route needs a logged-in user.
 *
 * ponytail: throwaway until Wave 2 replaces this with a multi-tenant seed
 * (2 orgs, 3 sites, 2 locales — PLAN §Files to create). Not idempotent: the
 * seed clears the collections it owns before writing.
 */
import config from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import { seed } from '@/endpoints/seed'

const payload = await getPayload({ config })

await seed({ payload, req: await createLocalReq({}, payload) })

process.exit(0)
