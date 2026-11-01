import { isMachineKey } from './content-paths'

/**
 * The typed custom-field schema a `content-type-definitions` row declares and
 * every `content-entries.fieldValues` document is validated against (issue
 * #166 §2). Pure and database-free: the collection hooks load the definition
 * row and hand its `fieldSchema` array here, and the theme API documents the
 * same shapes for renderers.
 *
 * Design rules, from the issue's "never drop silently" principle:
 *
 * - **Unknown top-level keys are reported, never discarded.** The entry hook
 *   moves them into `unmappedMeta`, where an editor can see and later map
 *   them. Unknown keys *inside* a group/repeater are validation errors: that
 *   schema was declared explicitly, so a stray key there is a typo to surface.
 * - **Types are strict.** ACF loves handing numbers back as strings; the
 *   importer coerces at its mapping boundary, and what lands in Eshobe is a
 *   real JSON number or it does not land.
 * - **Nothing is ever executed.** Values are JSON data only — no PHP
 *   unserialization, no `eval`, no function values. Size/depth guards keep a
 *   hostile export from turning one entry into a denial of service.
 * - **`json` is the escape hatch, flagged as such.** It preserves an exotic
 *   plugin payload losslessly but renders generically; the migration report
 *   counts it as "archived, not UI-compatible", per the issue.
 */

export const CUSTOM_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'boolean',
  'date',
  'url',
  'select',
  'multiselect',
  'media',
  'gallery',
  'relationship',
  'group',
  'repeater',
  'json',
] as const

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]

/** Persian admin labels for the field-type picker, in declaration order. */
export const CUSTOM_FIELD_TYPE_OPTIONS: { label: string; value: CustomFieldType }[] = [
  { label: 'متن کوتاه', value: 'text' },
  { label: 'متن بلند', value: 'textarea' },
  { label: 'عدد', value: 'number' },
  { label: 'بله / خیر', value: 'boolean' },
  { label: 'تاریخ و ساعت', value: 'date' },
  { label: 'نشانی (URL)', value: 'url' },
  { label: 'گزینش تکی', value: 'select' },
  { label: 'گزینش چندتایی', value: 'multiselect' },
  { label: 'رسانه', value: 'media' },
  { label: 'نگارخانه رسانه', value: 'gallery' },
  { label: 'رابطه با سند دیگر', value: 'relationship' },
  { label: 'گروه فیلدها', value: 'group' },
  { label: 'فهرست تکرارشونده', value: 'repeater' },
  { label: 'داده خام (JSON)', value: 'json' },
]

/** Collections a `relationship` custom field may point at — all site-scoped. */
export const CUSTOM_FIELD_RELATION_COLLECTIONS = [
  'content-entries',
  'pages',
  'posts',
  'products',
  'media',
  'taxonomy-terms',
] as const

export type CustomFieldRelationCollection = (typeof CUSTOM_FIELD_RELATION_COLLECTIONS)[number]

export type CustomFieldDefinition = {
  fieldType: CustomFieldType | string
  helpText?: null | string
  key: string
  label: string
  /** One `value|برچسب` (or bare `value`) per line; select/multiselect only. */
  optionsText?: null | string
  /** Target collection slug; relationship only. */
  relationTo?: null | string
  required?: boolean | null
  searchable?: boolean | null
  /** Nested definitions for group/repeater, stored as JSON on the row. */
  subSchema?: CustomFieldDefinition[] | null
}

export type FieldValueError = { message: string; path: string }

const MAX_DEPTH = 6
const MAX_STRING = 100_000
const MAX_ARRAY = 1_000
const MAX_SCHEMA_DEPTH = 4

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const isEmptyValue = (value: unknown): boolean =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)

const isIdLike = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= 64 && !/\s/.test(value)

/** `value|label` lines → options. A bare line is its own label. */
export const parseSelectOptions = (
  optionsText?: null | string,
): { label: string; value: string }[] =>
  (optionsText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, ...labelParts] = line.split('|')

      return { label: labelParts.join('|').trim() || value!.trim(), value: value!.trim() }
    })
    .filter((option) => option.value.length > 0)

/** Validate a definition's `fieldSchema` itself, before any value meets it. */
export const validateFieldSchema = (
  schema: unknown,
  depth = 0,
): FieldValueError[] => {
  if (depth > MAX_SCHEMA_DEPTH) return [{ message: 'عمق طرح فیلدها بیش از حد است.', path: '' }]
  if (!Array.isArray(schema)) return [{ message: 'طرح فیلدها باید فهرست باشد.', path: '' }]

  const errors: FieldValueError[] = []
  const seen = new Set<string>()

  schema.forEach((raw, index) => {
    const path = `fieldSchema.${index}`
    const field = raw as CustomFieldDefinition

    if (!isPlainObject(raw)) {
      errors.push({ message: 'هر ردیف طرح باید یک شیء باشد.', path })
      return
    }
    if (!isMachineKey(field.key) && !/^_[a-z][a-z0-9_-]{0,62}$/.test(String(field.key ?? ''))) {
      errors.push({ message: 'کلید فیلد ماشینی نیست.', path: `${path}.key` })
    } else if (seen.has(field.key)) {
      errors.push({ message: `کلید «${field.key}» تکراری است.`, path: `${path}.key` })
    }
    seen.add(String(field.key))

    if (!field.label || typeof field.label !== 'string') {
      errors.push({ message: 'برچسب فیلد لازم است.', path: `${path}.label` })
    }
    if (!(CUSTOM_FIELD_TYPES as readonly string[]).includes(String(field.fieldType))) {
      errors.push({ message: 'نوع فیلد شناخته‌شده نیست.', path: `${path}.fieldType` })
      return
    }
    if (
      (field.fieldType === 'select' || field.fieldType === 'multiselect') &&
      parseSelectOptions(field.optionsText).length === 0
    ) {
      errors.push({ message: 'فیلد گزینشی دست‌کم یک گزینه می‌خواهد.', path: `${path}.optionsText` })
    }
    if (field.fieldType === 'relationship') {
      if (
        !field.relationTo ||
        !(CUSTOM_FIELD_RELATION_COLLECTIONS as readonly string[]).includes(field.relationTo)
      ) {
        errors.push({
          message: 'مقصد رابطه باید یکی از مجموعه‌های مجاز باشد.',
          path: `${path}.relationTo`,
        })
      }
    }
    if (field.fieldType === 'group' || field.fieldType === 'repeater') {
      if (!Array.isArray(field.subSchema) || !field.subSchema.length) {
        errors.push({
          message: 'گروه/تکرارشونده به زیرطرح (subSchema) غیرخالی نیاز دارد.',
          path: `${path}.subSchema`,
        })
      } else {
        errors.push(
          ...validateFieldSchema(field.subSchema, depth + 1).map((error) => ({
            message: error.message,
            path: error.path ? `${path}.subSchema.${error.path.replace(/^fieldSchema\./, '')}` : `${path}.subSchema`,
          })),
        )
      }
    }
  })

  return errors
}

/** Is this value storable JSON within the size/depth guards? */
const assertJsonValue = (value: unknown, path: string, depth: number, errors: FieldValueError[]): void => {
  if (depth > MAX_DEPTH) {
    errors.push({ message: 'داده بیش از حد تو در تو است.', path })
    return
  }
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push({ message: 'عدد متناهی نیست.', path })
    return
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) errors.push({ message: 'رشته بیش از حد بلند است.', path })
    return
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) errors.push({ message: 'فهرست بیش از حد بلند است.', path })
    value.slice(0, MAX_ARRAY).forEach((item, i) => assertJsonValue(item, `${path}.${i}`, depth + 1, errors))
    return
  }
  if (isPlainObject(value)) {
    Object.entries(value).forEach(([key, item]) => assertJsonValue(item, `${path}.${key}`, depth + 1, errors))
    return
  }
  errors.push({ message: 'مقدار JSON معتبر نیست.', path })
}

const validateValueAgainstField = (
  field: CustomFieldDefinition,
  value: unknown,
  path: string,
  errors: FieldValueError[],
): void => {
  if (isEmptyValue(value)) {
    if (field.required) errors.push({ message: `فیلد «${field.label || field.key}» لازم است.`, path })
    return
  }

  switch (field.fieldType) {
    case 'text':
    case 'textarea': {
      if (typeof value !== 'string') errors.push({ message: 'مقدار متنی نیست.', path })
      else if (value.length > (field.fieldType === 'text' ? 2_000 : MAX_STRING)) {
        errors.push({ message: 'متن بیش از حد بلند است.', path })
      }
      return
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push({ message: 'مقدار باید عدد باشد (رشته عددی پذیرفته نمی‌شود).', path })
      }
      return
    }
    case 'boolean': {
      if (typeof value !== 'boolean') errors.push({ message: 'مقدار باید true یا false باشد.', path })
      return
    }
    case 'date': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        errors.push({ message: 'تاریخ معتبر (ISO) نیست.', path })
      }
      return
    }
    case 'url': {
      let ok = false
      try {
        const url = new URL(String(value))
        ok = url.protocol === 'https:' || url.protocol === 'http:'
      } catch {
        ok = false
      }
      if (!ok) errors.push({ message: 'نشانی http/https معتبر نیست.', path })
      return
    }
    case 'select': {
      const values = parseSelectOptions(field.optionsText).map((o) => o.value)
      if (typeof value !== 'string' || !values.includes(value)) {
        errors.push({ message: 'مقدار در گزینه‌های مجاز نیست.', path })
      }
      return
    }
    case 'multiselect': {
      const allowed = new Set(parseSelectOptions(field.optionsText).map((o) => o.value))
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !allowed.has(v))) {
        errors.push({ message: 'همه مقادیر باید در گزینه‌های مجاز باشند.', path })
      } else if (new Set(value).size !== value.length) {
        errors.push({ message: 'مقدار تکراری در گزینش چندتایی مجاز نیست.', path })
      }
      return
    }
    case 'media': {
      if (!isIdLike(value)) errors.push({ message: 'شناسه رسانه معتبر نیست.', path })
      return
    }
    case 'gallery': {
      if (!Array.isArray(value) || value.some((v) => !isIdLike(v))) {
        errors.push({ message: 'نگارخانه باید فهرست شناسه‌های رسانه باشد.', path })
      }
      return
    }
    case 'relationship': {
      const valid = Array.isArray(value) ? value.every(isIdLike) : isIdLike(value)
      if (!valid) errors.push({ message: 'شناسه رابطه معتبر نیست.', path })
      return
    }
    case 'group': {
      if (!isPlainObject(value)) {
        errors.push({ message: 'مقدار گروه باید شیء باشد.', path })
        return
      }
      validateObjectAgainstSchema(field.subSchema ?? [], value, path, errors, true)
      return
    }
    case 'repeater': {
      if (!Array.isArray(value)) {
        errors.push({ message: 'مقدار تکرارشونده باید فهرست باشد.', path })
        return
      }
      value.forEach((item, i) => {
        if (!isPlainObject(item)) {
          errors.push({ message: 'هر ردیف تکرارشونده باید شیء باشد.', path: `${path}.${i}` })
          return
        }
        validateObjectAgainstSchema(field.subSchema ?? [], item, `${path}.${i}`, errors, true)
      })
      return
    }
    case 'json': {
      assertJsonValue(value, path, 0, errors)
      return
    }
    default: {
      errors.push({ message: `نوع فیلد «${String(field.fieldType)}» پشتیبانی نمی‌شود.`, path })
    }
  }
}

const validateObjectAgainstSchema = (
  schema: CustomFieldDefinition[],
  values: Record<string, unknown>,
  basePath: string,
  errors: FieldValueError[],
  nested: boolean,
): string[] => {
  const byKey = new Map(schema.map((field) => [field.key, field]))
  const unknown: string[] = []

  for (const [key, value] of Object.entries(values)) {
    const field = byKey.get(key)
    const path = basePath ? `${basePath}.${key}` : key

    if (!field) {
      if (nested) errors.push({ message: `کلید «${key}» در طرح نیست.`, path })
      else unknown.push(key)
      continue
    }
    validateValueAgainstField(field, value, path, errors)
  }

  // Required fields that never arrived are errors too — Object.entries only
  // visits what is present.
  for (const field of schema) {
    if (field.required && !(field.key in values)) {
      errors.push({
        message: `فیلد «${field.label || field.key}» لازم است.`,
        path: basePath ? `${basePath}.${field.key}` : field.key,
      })
    }
  }

  return unknown
}

export type FieldValuesValidation = {
  errors: FieldValueError[]
  /** Top-level keys the schema does not declare — preserved by the caller. */
  unknownKeys: string[]
}

/** Validate one entry's `fieldValues` JSON against its type's schema. */
export const validateFieldValues = (
  schema: CustomFieldDefinition[] | null | undefined,
  values: unknown,
): FieldValuesValidation => {
  if (values === undefined || values === null) {
    const errors = (schema ?? [])
      .filter((field) => field.required)
      .map((field) => ({ message: `فیلد «${field.label || field.key}» لازم است.`, path: field.key }))

    return { errors, unknownKeys: [] }
  }
  if (!isPlainObject(values)) {
    return { errors: [{ message: 'مقادیر فیلدها باید شیء JSON باشد.', path: 'fieldValues' }], unknownKeys: [] }
  }

  const errors: FieldValueError[] = []
  const unknownKeys = validateObjectAgainstSchema(schema ?? [], values, '', errors, false)

  return { errors, unknownKeys: unknownKeys.sort() }
}

/**
 * Split incoming values into schema-known values and the unmapped remainder.
 * The entry hook stores the remainder in `unmappedMeta` so an imported ACF key
 * with no mapping yet survives the write instead of vanishing or blocking it.
 */
export const splitKnownValues = (
  schema: CustomFieldDefinition[] | null | undefined,
  values: unknown,
): { known: Record<string, unknown>; unknown: Record<string, unknown> } => {
  if (!isPlainObject(values)) return { known: {}, unknown: {} }

  const knownKeys = new Set((schema ?? []).map((field) => field.key))
  const known: Record<string, unknown> = {}
  const unknown: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(values)) {
    if (knownKeys.has(key)) known[key] = value
    else unknown[key] = value
  }

  return { known, unknown }
}

const textOfValue = (field: CustomFieldDefinition, value: unknown): string => {
  if (isEmptyValue(value)) return ''

  switch (field.fieldType) {
    case 'text':
    case 'textarea':
    case 'url':
    case 'date':
    case 'select':
      return String(value)
    case 'number':
      return String(value)
    case 'multiselect':
      return Array.isArray(value) ? value.join(' ') : ''
    case 'group':
      return isPlainObject(value) ? searchableTextForValues(field.subSchema ?? [], value) : ''
    case 'repeater':
      return Array.isArray(value)
        ? value
            .map((item) => (isPlainObject(item) ? searchableTextForValues(field.subSchema ?? [], item) : ''))
            .join(' ')
        : ''
    default:
      return ''
  }
}

/**
 * The denormalized plain-text form of every `searchable` field — what
 * `content-entries.searchText` stores so a storefront can substring-filter on
 * a city name or a material without indexing into JSON.
 */
export const searchableTextForValues = (
  schema: CustomFieldDefinition[] | null | undefined,
  values: unknown,
): string => {
  if (!isPlainObject(values)) return ''

  return (schema ?? [])
    .filter((field) => field.searchable)
    .map((field) => textOfValue(field, values[field.key]))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 10_000)
}

/** Every media id a values document references, for the same-site hook check. */
export const mediaIdsInValues = (
  schema: CustomFieldDefinition[] | null | undefined,
  values: unknown,
): string[] => {
  if (!isPlainObject(values)) return []

  const ids: string[] = []

  const walk = (fields: CustomFieldDefinition[], object: Record<string, unknown>): void => {
    for (const field of fields) {
      const value = object[field.key]

      if (field.fieldType === 'media' && isIdLike(value)) ids.push(value)
      if (field.fieldType === 'gallery' && Array.isArray(value)) {
        value.forEach((id) => { if (isIdLike(id)) ids.push(id) })
      }
      if (field.fieldType === 'group' && isPlainObject(value)) walk(field.subSchema ?? [], value)
      if (field.fieldType === 'repeater' && Array.isArray(value)) {
        value.forEach((item) => { if (isPlainObject(item)) walk(field.subSchema ?? [], item) })
      }
    }
  }

  walk(schema ?? [], values)

  return [...new Set(ids)]
}

/** Every document reference a values document makes, grouped by collection. */
export const relationshipRefsInValues = (
  schema: CustomFieldDefinition[] | null | undefined,
  values: unknown,
): { collection: string; ids: string[] }[] => {
  if (!isPlainObject(values)) return []

  const byCollection = new Map<string, Set<string>>()

  const walk = (fields: CustomFieldDefinition[], object: Record<string, unknown>): void => {
    for (const field of fields) {
      const value = object[field.key]

      if (field.fieldType === 'relationship' && field.relationTo) {
        const set = byCollection.get(field.relationTo) ?? new Set<string>()
        ;(Array.isArray(value) ? value : [value]).forEach((id) => { if (isIdLike(id)) set.add(id) })
        byCollection.set(field.relationTo, set)
      }
      if (field.fieldType === 'group' && isPlainObject(value)) walk(field.subSchema ?? [], value)
      if (field.fieldType === 'repeater' && Array.isArray(value)) {
        value.forEach((item) => { if (isPlainObject(item)) walk(field.subSchema ?? [], item) })
      }
    }
  }

  walk(schema ?? [], values)

  return [...byCollection.entries()].map(([collection, ids]) => ({ collection, ids: [...ids] }))
}
