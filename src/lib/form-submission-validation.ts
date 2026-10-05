/**
 * Server-side validation of a public form submission against the form's own fields.
 *
 * The form-builder plugin stores whatever `submissionData` it is given: a crafted request
 * could skip a required field, attach fields the form never asked for, or send megabytes
 * into a notification email. Themes validate in the browser for feedback; this is the
 * check that holds. It runs for anonymous submissions only (staff writing through the
 * admin or Local API are trusted), after the honeypot is stripped and the tenant is
 * resolved from the form — see the `beforeValidate` hook in `src/plugins/index.ts`.
 */

export type SubmissionFormField = {
  blockType?: string | null
  name?: string | null
  required?: boolean | null
  options?: { value?: string | null }[] | null
}

export type SubmissionEntry = { field: string; value: string }

export type SubmissionValidation =
  | { ok: true; submissionData: SubmissionEntry[] }
  | { ok: false; reason: string }

/** Longest value a field may carry: a message box gets room, everything else a line. */
export const SUBMISSION_LIMITS = { textarea: 5_000, other: 500 } as const

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Field kinds a visitor fills in; `message` (prose) and `payment` (disabled) carry no value. */
const INPUT_KINDS = new Set(['text', 'textarea', 'email', 'number', 'select', 'checkbox', 'country', 'state'])

const scalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

export function validateSubmissionData(fields: SubmissionFormField[] | null | undefined, submissionData: unknown): SubmissionValidation {
  if (!Array.isArray(submissionData)) return { ok: false, reason: 'submissionData must be an array' }

  const inputs = (fields ?? []).filter(
    (f): f is SubmissionFormField & { name: string } => Boolean(f?.name) && INPUT_KINDS.has(String(f?.blockType)),
  )
  const byName = new Map(inputs.map((f) => [f.name, f]))
  const values = new Map<string, string>()

  for (const entry of submissionData) {
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'malformed entry' }
    const { field, value } = entry as { field?: unknown; value?: unknown }
    if (typeof field !== 'string' || !byName.has(field)) return { ok: false, reason: 'undeclared field' }
    if (values.has(field)) return { ok: false, reason: 'duplicate field' }
    if (value !== undefined && value !== null && !scalar(value)) return { ok: false, reason: 'non-scalar value' }
    values.set(field, value === undefined || value === null ? '' : String(value))
  }

  for (const field of inputs) {
    const value = values.get(field.name) ?? ''
    const empty = field.blockType === 'checkbox' ? value !== 'true' : !value.trim()
    if (field.required && empty) return { ok: false, reason: `missing required field` }
    if (!value.trim()) continue
    const limit = field.blockType === 'textarea' ? SUBMISSION_LIMITS.textarea : SUBMISSION_LIMITS.other
    if (value.length > limit) return { ok: false, reason: 'value too long' }
    if (field.blockType === 'email' && !EMAIL.test(value.trim())) return { ok: false, reason: 'invalid email' }
    if (field.blockType === 'number' && Number.isNaN(Number(value))) return { ok: false, reason: 'invalid number' }
    if (field.blockType === 'select' && field.options?.length && !field.options.some((o) => o?.value === value)) {
      return { ok: false, reason: 'unknown option' }
    }
  }

  return {
    ok: true,
    submissionData: inputs.filter((f) => values.has(f.name)).map((f) => ({ field: f.name, value: values.get(f.name)!.trim() })),
  }
}
