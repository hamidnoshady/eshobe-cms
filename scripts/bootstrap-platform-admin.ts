import config from '@payload-config'
import { getPayload } from 'payload'

import { bootstrapTokenMatches } from '@/lib/admin-bootstrap'

const configuredToken = process.env.PLATFORM_ADMIN_BOOTSTRAP_SECRET
const suppliedToken = process.env.PLATFORM_ADMIN_BOOTSTRAP_TOKEN
const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase()
const password = process.env.PLATFORM_ADMIN_PASSWORD

if (!bootstrapTokenMatches(configuredToken, suppliedToken)) {
  throw new Error('Platform admin bootstrap refused: bootstrap token is missing or incorrect.')
}

if (!email || !email.includes('@')) {
  throw new Error('Platform admin bootstrap requires a valid PLATFORM_ADMIN_EMAIL.')
}

if (!password || password.length < 16) {
  throw new Error('Platform admin bootstrap requires a PLATFORM_ADMIN_PASSWORD of at least 16 characters.')
}

const payload = await getPayload({ config })

try {
  const { totalDocs: existingAdmins } = await payload.count({
    collection: 'users',
    overrideAccess: true,
    where: { role: { equals: 'platformAdmin' } },
  })

  if (existingAdmins > 0) {
    throw new Error('Platform admin bootstrap refused: a platform admin already exists.')
  }

  const existing = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { email: { equals: email } },
  })

  if (existing.docs[0]) {
    await payload.update({
      collection: 'users',
      context: { platformAdminBootstrap: true },
      data: { password, role: 'platformAdmin' },
      depth: 0,
      id: existing.docs[0].id,
      overrideAccess: true,
    })
  } else {
    await payload.create({
      collection: 'users',
      context: { platformAdminBootstrap: true },
      data: { email, name: 'Platform administrator', password, role: 'platformAdmin' },
      depth: 0,
      overrideAccess: true,
    })
  }

  payload.logger.info({ email, msg: 'Initial platform administrator bootstrapped.' })
} finally {
  await payload.destroy()
}
