import { afterEach, describe, expect, it } from 'vitest'

import {
  enforcePublicFormSubmissionRateLimit,
  stripPublicFormHoneypot,
  verifyPublicFormChallenge,
} from '@/lib/form-submission-rate-limit'
import { PUBLIC_FORM_HONEYPOT_FIELD } from '@/lib/public-form-fields'
import { resetRateLimits } from '@/lib/rate-limit'

afterEach(() => resetRateLimits())

describe('anonymous public form submission protections', () => {
  const makeRequest = (ip: string) => ({
    headers: new Headers({ 'x-forwarded-for': ip }),
    method: 'POST',
    payloadAPI: 'REST',
    responseHeaders: new Headers(),
    user: null,
  })

  it('throttles a client per resolved site without making unrelated tenants share a quota', () => {
    const request = makeRequest('203.0.113.42')
    const options = { limit: 2, windowMs: 60_000 }

    expect(() => enforcePublicFormSubmissionRateLimit(request as never, 'acme-site', options)).not.toThrow()
    expect(() => enforcePublicFormSubmissionRateLimit(request as never, 'acme-site', options)).not.toThrow()
    expect(() => enforcePublicFormSubmissionRateLimit(request as never, 'studio-site', options)).not.toThrow()
    expect(() => enforcePublicFormSubmissionRateLimit(makeRequest('203.0.113.43') as never, 'acme-site', options)).not.toThrow()

    try {
      enforcePublicFormSubmissionRateLimit(request as never, 'acme-site', options)
      throw new Error('expected rate limit error')
    } catch (error) {
      expect(error).toMatchObject({ status: 429 })
    }

    expect(request.responseHeaders.get('cache-control')).toBe('no-store')
    expect(request.responseHeaders.get('retry-after')).toBeTruthy()
  })

  it('uses a bounded unresolved-form bucket for malformed form IDs', () => {
    const request = makeRequest('203.0.113.44')
    const options = { limit: 1, windowMs: 60_000 }
    enforcePublicFormSubmissionRateLimit(request as never, null, options)

    expect(() => enforcePublicFormSubmissionRateLimit(request as never, null, options)).toThrow(
      'Too many form submissions. Please wait and try again.',
    )
  })

  it('does not throttle local jobs/scripts or an authenticated admin session', () => {
    const localRequest = {
      ...makeRequest('203.0.113.45'),
      payloadAPI: 'local',
    }
    const adminRequest = {
      ...makeRequest('203.0.113.46'),
      user: { id: 'admin', collection: 'users' },
    }

    for (let i = 0; i < 3; i += 1) {
      expect(() => enforcePublicFormSubmissionRateLimit(localRequest as never, 'site', { limit: 1 })).not.toThrow()
      expect(() => enforcePublicFormSubmissionRateLimit(adminRequest as never, 'site', { limit: 1 })).not.toThrow()
    }
  })

  it('removes an empty honeypot value and flags a filled one without preserving the trap field', () => {
    const clean = stripPublicFormHoneypot({
      form: 'form-id',
      submissionData: [
        { field: 'email', value: 'person@example.test' },
        { field: PUBLIC_FORM_HONEYPOT_FIELD, value: '   ' },
      ],
    })
    expect(clean.filled).toBe(false)
    expect(clean.data).toEqual({ form: 'form-id', submissionData: [{ field: 'email', value: 'person@example.test' }] })

    const bot = stripPublicFormHoneypot({
      submissionData: [{ field: PUBLIC_FORM_HONEYPOT_FIELD, value: 'https://spam.example' }],
    })
    expect(bot.filled).toBe(true)
    expect(JSON.stringify(bot.data)).not.toContain(PUBLIC_FORM_HONEYPOT_FIELD)
  })

  it('runs an optional challenge verifier and fails closed if it rejects or throws', async () => {
    const context = {
      data: { form: 'form-id' },
      req: {
        payload: {
          config: {
            custom: { verifyPublicFormSubmission: async () => true },
          },
        },
      },
      siteID: 'site-id',
    }
    expect(await verifyPublicFormChallenge(context as never)).toBe(true)

    const rejected = {
      ...context,
      req: { payload: { config: { custom: { verifyPublicFormSubmission: async () => false } } } },
    }
    expect(await verifyPublicFormChallenge(rejected as never)).toBe(false)

    const broken = {
      ...context,
      req: { payload: { config: { custom: { verifyPublicFormSubmission: async () => { throw new Error('offline') } } } } },
    }
    expect(await verifyPublicFormChallenge(broken as never)).toBe(false)

    expect(await verifyPublicFormChallenge({ ...context, req: { payload: { config: {} } } } as never)).toBe(true)
  })
})
