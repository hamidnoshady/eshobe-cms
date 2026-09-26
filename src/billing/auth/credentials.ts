import { randomBytes } from 'node:crypto'

import type { PayloadRequest } from 'payload'

import { decryptBillingSecret, encryptBillingSecret } from '@/billing/auth/crypto'
import { BILLING_SCOPES, type BillingScope, isBillingScope } from '@/billing/auth/sign'

/** Set only by `activeBillingCredentials`. A read without it returns a blank secret. */
export const BILLING_SECRET_READ = 'billingSecretRead'

export const maskBillingSecret = ({
  doc,
  req,
}: {
  doc: Record<string, unknown>
  req?: { context?: Record<string, unknown> }
}): Record<string, unknown> => {
  if (req?.context?.[BILLING_SECRET_READ] === true) return doc
  return { ...doc, secret: '' }
}

const scopesOf = (value: unknown): BillingScope[] => {
  if (!Array.isArray(value)) return []
  return value.filter(isBillingScope)
}

export type IssuedCredential = { keyId: string; scopes: BillingScope[]; secret: string }

/** The raw secret exists only in this return value. */
export const issueBillingCredential = async (
  req: PayloadRequest,
  args: { label: string; scopes?: BillingScope[] },
): Promise<IssuedCredential> => {
  const scopes = (args.scopes?.length ? args.scopes : [...BILLING_SCOPES]).filter(isBillingScope)
  const keyId = `bsk_${randomBytes(9).toString('hex')}`
  const secret = `bsec_${randomBytes(24).toString('hex')}`
  await req.payload.create({
    collection: 'billing-service-credentials',
    data: {
      keyId,
      label: args.label.slice(0, 120),
      scopes,
      secret: encryptBillingSecret(secret),
      status: 'active',
    },
    depth: 0,
    overrideAccess: true,
    req,
  })
  return { keyId, scopes, secret }
}

export type ActiveCredential = { id: string; keyId: string; scopes: BillingScope[]; secret: string }

export const activeBillingCredentials = async (req: PayloadRequest): Promise<ActiveCredential[]> => {
  const previous = req.context[BILLING_SECRET_READ]
  req.context[BILLING_SECRET_READ] = true
  const { docs } = await req.payload.find({
    collection: 'billing-service-credentials',
    depth: 0,
    limit: 20,
    overrideAccess: true,
    pagination: false,
    req,
    sort: '-createdAt',
    where: { status: { equals: 'active' } },
  })
  if (previous === undefined) delete req.context[BILLING_SECRET_READ]
  else req.context[BILLING_SECRET_READ] = previous
  const usable: ActiveCredential[] = []
  for (const doc of docs as unknown as Record<string, unknown>[]) {
    const secret = decryptBillingSecret(typeof doc.secret === 'string' ? doc.secret : null)
    if (!secret) continue
    usable.push({
      id: String(doc.id),
      keyId: String(doc.keyId ?? ''),
      scopes: scopesOf(doc.scopes),
      secret,
    })
  }
  return usable
}

export const credentialForScope = async (
  req: PayloadRequest,
  scope: BillingScope,
): Promise<ActiveCredential | null> => {
  const all = await activeBillingCredentials(req)
  return all.find((item) => item.scopes.includes(scope)) ?? null
}

export const revokeBillingCredential = async (req: PayloadRequest, keyId: string): Promise<boolean> => {
  const { docs } = await req.payload.find({
    collection: 'billing-service-credentials',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { keyId: { equals: keyId } },
  })
  const doc = docs[0] as { id?: unknown } | undefined
  if (!doc?.id) return false
  await req.payload.update({
    id: String(doc.id),
    collection: 'billing-service-credentials',
    data: { status: 'revoked' },
    depth: 0,
    overrideAccess: true,
    req,
  })
  return true
}
