// @vitest-environment node
import { describe, expect, it } from 'vitest'

import type { CustomFieldDefinition } from '@/lib/custom-fields'
import {
  mediaIdsInValues,
  parseSelectOptions,
  relationshipRefsInValues,
  searchableTextForValues,
  splitKnownValues,
  validateFieldSchema,
  validateFieldValues,
} from '@/lib/custom-fields'
import {
  archiveSlugOf,
  entryPath,
  isMachineKey,
  isValidArchiveSlug,
  matchContentRoute,
  termArchivePath,
} from '@/lib/content-paths'
import { htmlToPlainText, plainTextToParagraphs } from '@/lib/html-text'

const schema: CustomFieldDefinition[] = [
  { fieldType: 'text', key: 'client', label: 'کارفرما', required: true, searchable: true },
  { fieldType: 'number', key: 'year', label: 'سال' },
  { fieldType: 'select', key: 'kind', label: 'گونه', optionsText: 'residential|مسکونی\ncommercial|تجاری' },
  { fieldType: 'multiselect', key: 'materials', label: 'مصالح', optionsText: 'brick\nwood\nglass', searchable: true },
  { fieldType: 'media', key: 'cover', label: 'پوستر' },
  { fieldType: 'gallery', key: 'shots', label: 'عکس‌ها' },
  { fieldType: 'relationship', key: 'related', label: 'مرتبط', relationTo: 'content-entries' },
  {
    fieldType: 'group',
    key: 'location',
    label: 'مکان',
    subSchema: [
      { fieldType: 'text', key: 'city', label: 'شهر', searchable: true },
      { fieldType: 'number', key: 'area', label: 'متراژ' },
    ],
  },
  {
    fieldType: 'repeater',
    key: 'specs',
    label: 'مشخصات',
    subSchema: [{ fieldType: 'text', key: 'label', label: 'عنوان', required: true }],
  },
]

describe('custom field schema (issue #166)', () => {
  it('accepts a well-formed schema and rejects duplicate/invalid keys', () => {
    expect(validateFieldSchema(schema)).toEqual([])
    expect(
      validateFieldSchema([
        { fieldType: 'text', key: 'Client Name', label: 'x' },
        { fieldType: 'text', key: 'client', label: 'x' },
        { fieldType: 'text', key: 'client', label: 'y' },
      ]).map((e) => e.path),
    ).toEqual(expect.arrayContaining(['fieldSchema.0.key', 'fieldSchema.2.key']))
  })

  it('requires options for selects and a known target for relationships', () => {
    const errors = validateFieldSchema([
      { fieldType: 'select', key: 'kind', label: 'گونه' },
      { fieldType: 'relationship', key: 'owner', label: 'مالک', relationTo: 'users' },
      { fieldType: 'group', key: 'empty', label: 'خالی' },
    ])
    expect(errors.map((e) => e.path)).toEqual([
      'fieldSchema.0.optionsText',
      'fieldSchema.1.relationTo',
      'fieldSchema.2.subSchema',
    ])
  })

  it('parses `value|label` option lines', () => {
    expect(parseSelectOptions('a|الف\n\n b \nc|')).toEqual([
      { label: 'الف', value: 'a' },
      { label: 'b', value: 'b' },
      { label: 'c', value: 'c' },
    ])
  })

  it('validates values strictly by type, including nested group/repeater', () => {
    const good = {
      client: 'شرکت آوا',
      cover: '3d0f6f3c-0000-4000-8000-000000000001',
      kind: 'residential',
      location: { area: 180, city: 'رامسر' },
      materials: ['brick', 'wood'],
      related: ['3d0f6f3c-0000-4000-8000-000000000002'],
      shots: ['3d0f6f3c-0000-4000-8000-000000000001'],
      specs: [{ label: 'متراژ' }],
      year: 1402,
    }
    expect(validateFieldValues(schema, good)).toEqual({ errors: [], unknownKeys: [] })

    const bad = validateFieldValues(schema, {
      kind: 'villa', // not an option
      location: { area: '180', planet: 'earth' }, // string number + nested unknown
      materials: ['brick', 'brick'], // duplicate
      specs: [{}], // missing required label
      year: '1402', // ACF-style string number must not pass silently
      // client missing → required
    })
    expect(bad.errors.map((e) => e.path).sort()).toEqual([
      'client',
      'kind',
      'location.area',
      'location.planet',
      'materials',
      'specs.0.label',
      'year',
    ])
  })

  it('reports unknown top-level keys for preservation instead of dropping them', () => {
    const values = { client: 'آوا', legacy_acf_key: { nested: true }, year: 1400 }
    expect(validateFieldValues(schema, values).unknownKeys).toEqual(['legacy_acf_key'])
    expect(splitKnownValues(schema, values)).toEqual({
      known: { client: 'آوا', year: 1400 },
      unknown: { legacy_acf_key: { nested: true } },
    })
  })

  it('builds search text from searchable fields only and collects references', () => {
    const values = {
      client: 'شرکت آوا',
      cover: 'aaaaaaaa-0000-4000-8000-000000000001',
      location: { area: 180, city: 'رامسر' },
      materials: ['brick'],
      related: 'bbbbbbbb-0000-4000-8000-000000000002',
      shots: ['cccccccc-0000-4000-8000-000000000003'],
      year: 1402, // not searchable
    }
    const text = searchableTextForValues(schema, values)
    expect(text).toContain('شرکت آوا')
    expect(text).toContain('brick')
    expect(text).not.toContain('1402')
    // Group subfields are not top-level searchable rows of the *parent* schema —
    // city only counts when the group itself is marked searchable.
    expect(mediaIdsInValues(schema, values).sort()).toEqual([
      'aaaaaaaa-0000-4000-8000-000000000001',
      'cccccccc-0000-4000-8000-000000000003',
    ])
    expect(relationshipRefsInValues(schema, values)).toEqual([
      { collection: 'content-entries', ids: ['bbbbbbbb-0000-4000-8000-000000000002'] },
    ])
  })
})

describe('content paths (issue #166 §3)', () => {
  it('validates machine keys and archive slugs, refusing reserved segments', () => {
    expect(isMachineKey('portfolio')).toBe(true)
    expect(isMachineKey('نمونه-کار')).toBe(false)
    expect(isValidArchiveSlug('نمونه-کار')).toBe(true)
    expect(isValidArchiveSlug('portfolio')).toBe(true)
    expect(isValidArchiveSlug('posts')).toBe(false)
    expect(isValidArchiveSlug('en')).toBe(false) // locale prefix
    expect(isValidArchiveSlug('a/b')).toBe(false)
    expect(isValidArchiveSlug('Two Words')).toBe(false)
  })

  it('builds entry and term paths from definitions', () => {
    const type = { archiveSlug: 'نمونه-کار', id: 't1', key: 'portfolio' }
    expect(archiveSlugOf(type)).toBe('نمونه-کار')
    expect(entryPath(type, { id: 'e1', slug: 'خانه-دریا' })).toBe('/نمونه-کار/خانه-دریا')
    expect(entryPath({ ...type, permalinkTemplate: '/{slug}' }, { id: 'e1', slug: 'x' })).toBe('/x')
    expect(
      termArchivePath({ archiveSlug: 'سبک', id: 'x1', key: 'genre' }, ['مسکونی', 'ویلایی']),
    ).toBe('/سبک/مسکونی/ویلایی')
  })

  it('matches entry/archive/term routes and keeps flat taxonomies flat', () => {
    const definitions = {
      taxonomies: [
        { archiveSlug: 'سبک', hierarchical: true, id: 'x1', key: 'genre' },
        { archiveSlug: 'برچسب', hierarchical: false, id: 'x2', key: 'post_tag' },
      ],
      types: [{ archiveSlug: 'نمونه-کار', id: 't1', key: 'portfolio' }],
    }
    expect(matchContentRoute(definitions, ['نمونه-کار'])).toEqual({
      kind: 'type-archive',
      typeId: 't1',
      typeKey: 'portfolio',
    })
    expect(matchContentRoute(definitions, ['نمونه-کار', 'خانه-دریا'])).toEqual({
      kind: 'entry',
      slug: 'خانه-دریا',
      typeId: 't1',
      typeKey: 'portfolio',
    })
    expect(matchContentRoute(definitions, ['سبک', 'مسکونی', 'ویلایی'])).toEqual({
      kind: 'term-archive',
      taxonomyId: 'x1',
      taxonomyKey: 'genre',
      termSlugs: ['مسکونی', 'ویلایی'],
    })
    expect(matchContentRoute(definitions, ['برچسب', 'الف', 'ب'])).toBeNull()
    expect(matchContentRoute(definitions, ['ناشناخته'])).toBeNull()
    expect(matchContentRoute(definitions, [])).toBeNull()
  })

  it('strips archived HTML to safe plain text with paragraphs', () => {
    const text = htmlToPlainText(
      '<p onclick="x()">سلام &laquo;دنیا&raquo;</p><script>alert(1)</script><ul><li>یک</li><li>دو</li></ul>',
    )
    expect(text).toContain('سلام «دنیا»')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('<')
    expect(plainTextToParagraphs(text)[0]).toContain('سلام')
  })
})
