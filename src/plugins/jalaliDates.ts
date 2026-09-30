import type { Field, Plugin } from 'payload'

const FIELD = '@/fields/JalaliDateField#JalaliDateField'

// Recurse into every container that holds `fields` — including tabs and blocks.
const walk = (fields: Field[]): Field[] =>
  fields.map((f) => {
    if (f.type === 'date' && !f.admin?.components?.Field) {
      return { ...f, admin: { ...f.admin, components: { ...f.admin?.components, Field: FIELD } } }
    }
    if (f.type === 'tabs') return { ...f, tabs: f.tabs.map((t) => ({ ...t, fields: walk(t.fields) })) }
    if (f.type === 'blocks') return { ...f, blocks: f.blocks.map((b) => ({ ...b, fields: walk(b.fields) })) }
    if ('fields' in f && Array.isArray(f.fields)) return { ...f, fields: walk(f.fields) } as Field
    return f
  })

/**
 * Every `date` field gets the Jalali picker in the Persian admin. The component itself
 * falls back to Payload's stock picker for English, so this is safe to apply blanket.
 * Runs last so fields added by other plugins are covered.
 */
export const jalaliDates: Plugin = (config) => ({
  ...config,
  collections: config.collections?.map((c) => ({ ...c, fields: walk(c.fields) })),
  globals: config.globals?.map((g) => ({ ...g, fields: walk(g.fields) })),
})
