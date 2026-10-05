import { REST_POST } from '@payloadcms/next/routes'
import config from '@payload-config'
import { getPayload, type Payload } from 'payload'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { idOf } from '@/lib/ids'
import { SUBMISSION_LIMITS, validateSubmissionData, type SubmissionFormField } from '@/lib/form-submission-validation'
import { resetRateLimits } from '@/lib/rate-limit'

const fields: SubmissionFormField[] = [
  { blockType: 'text', name: 'name', required: true },
  { blockType: 'email', name: 'email', required: true },
  { blockType: 'textarea', name: 'message', required: false },
  { blockType: 'select', name: 'topic', options: [{ value: 'house' }, { value: 'office' }] },
  { blockType: 'checkbox', name: 'consent', required: true },
  { blockType: 'message', name: undefined },
]
const valid = [
  { field: 'name', value: ' سارا ' },
  { field: 'email', value: 'sara@example.test' },
  { field: 'consent', value: true },
]

describe('public submission rules', () => {
  it('keeps only declared fields, trimmed, as strings', () => {
    expect(validateSubmissionData(fields, valid)).toEqual({
      ok: true,
      submissionData: [
        { field: 'name', value: 'سارا' },
        { field: 'email', value: 'sara@example.test' },
        { field: 'consent', value: 'true' },
      ],
    })
  })

  it('refuses what the form did not ask for, or asked for differently', () => {
    const cases: [unknown, string][] = [
      ['not an array', 'submissionData must be an array'],
      [[...valid, { field: 'site', value: 'another-tenant' }], 'undeclared field'],
      [[...valid, valid[0]], 'duplicate field'],
      [[valid[0], valid[1]], 'missing required field'],
      [[valid[0], { field: 'email', value: 'nope' }, valid[2]], 'invalid email'],
      [[...valid, { field: 'topic', value: 'castle' }], 'unknown option'],
      [[...valid, { field: 'message', value: 'x'.repeat(SUBMISSION_LIMITS.textarea + 1) }], 'value too long'],
      [[{ field: 'name', value: { $gt: '' } }], 'non-scalar value'],
      [[...valid.slice(0, 2), { field: 'consent', value: false }], 'missing required field'],
    ]
    for (const [data, reason] of cases) expect(validateSubmissionData(fields, data)).toEqual({ ok: false, reason })
  })
})

describe('POST /api/form-submissions (REST)', () => {
  let payload: Payload
  let formId: string
  let siteId: string
  const post = REST_POST(config)

  beforeAll(async () => {
    payload = await getPayload({ config: await config })
    const site = (await payload.find({ collection: 'sites', where: { domain: { equals: 'acme.localhost' } }, depth: 0, limit: 1 })).docs[0]
    siteId = String(site!.id)
    const form = await payload.create({
      collection: 'forms',
      overrideAccess: true,
      data: {
        title: 'Validation fixture',
        site: siteId,
        confirmationType: 'message',
        confirmationMessage: {
          root: {
            type: 'root', direction: 'ltr', format: '', indent: 0, version: 1,
            children: [{ type: 'paragraph', direction: 'ltr', format: '', indent: 0, version: 1, children: [{ type: 'text', text: 'Thanks', version: 1 }] }],
          },
        },
        fields: [
          { blockType: 'text', name: 'name', label: 'Name', required: true },
          { blockType: 'email', name: 'email', label: 'Email', required: true },
        ],
      } as never,
    })
    formId = String(form.id)
  }, 180_000)

  afterEach(() => resetRateLimits())

  const submit = (submissionData: unknown, ip: string) =>
    post(
      new Request('http://acme.localhost:3000/api/form-submissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'acme.localhost', 'x-forwarded-for': ip },
        body: JSON.stringify({ form: formId, submissionData }),
      }),
      { params: Promise.resolve({ slug: ['form-submissions'] }) },
    )

  const stored = async () =>
    (await payload.find({ collection: 'form-submissions', overrideAccess: true, where: { form: { equals: formId } }, depth: 0 })).docs

  it('stores a valid anonymous submission on the form’s own site, with declared fields only', async () => {
    const before = (await stored()).length
    const res = await submit([{ field: 'name', value: 'Sara' }, { field: 'email', value: 'sara@example.test' }], '198.51.100.1')
    expect(res.status).toBe(201)
    const docs = await stored()
    expect(docs).toHaveLength(before + 1)
    const doc = docs.find((d) => (d.submissionData ?? []).some((e) => e.value === 'Sara'))!
    expect(idOf(doc.site as never)).toBe(siteId)
    expect(doc.submissionData?.map((e) => e.field)).toEqual(['name', 'email'])
  })

  it('rejects a crafted submission that skips a required field or smuggles one, and stores nothing', async () => {
    const before = (await stored()).length
    const skipped = await submit([{ field: 'name', value: 'Bot' }], '198.51.100.2')
    expect(skipped.status).toBe(400)
    const smuggled = await submit(
      [{ field: 'name', value: 'Bot' }, { field: 'email', value: 'b@example.test' }, { field: 'site', value: 'x' }],
      '198.51.100.3',
    )
    expect(smuggled.status).toBe(400)
    expect(await stored()).toHaveLength(before)
  })
})
