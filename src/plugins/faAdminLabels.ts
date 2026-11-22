import type { CollectionConfig, Field, Plugin } from 'payload'

/**
 * Persian for the English a *plugin* puts in the admin, and nothing else.
 *
 * Only the plugin-injected output is touched, named explicitly below:
 *
 * - `payload-mcp-api-keys` — `@payloadcms/plugin-mcp` ships no dictionary at all, so a
 *   Persian editor sees `Create`, `Tools`, `API Keys` and one collapsible per capability.
 * - `categories.breadcrumbs` — `@payloadcms/plugin-nested-docs` adds the field with no
 *   label, and Payload then humanises the name (`Breadcrumbs`, `Doc`, `URL`).
 *
 * Editing those plugins' `dist` would be undone by the next `pnpm update`; a config
 * transform is applied on every boot, so an upgrade cannot put the English back.
 *
 * Repo-owned collections are translated where they are declared, not here — a blanket
 * walk over every collection would silently override a label somebody wrote on purpose
 * (and make an English label look translated when it is only mapped from one string).
 *
 * `i18n.translations.fa` in `payload.config.ts` is the right home for a plugin that
 * *has* a translation namespace but no `fa` dictionary (`plugin-redirects`). This module
 * is for the ones that have no namespace to translate into at all.
 *
 * Both maps key on the exact English string: a plugin that rewords its copy falls back
 * to English rather than rendering a wrong Persian sentence, and adding one line here
 * fixes it again.
 */
const MCP_API_KEYS_SLUG = 'payload-mcp-api-keys'

/** The one field `plugin-nested-docs` injects into a configured collection. */
const NESTED_DOCS_FIELD = 'breadcrumbs'

const LABELS: Record<string, string> = {
  // plugin-mcp — the key editor's capability checkboxes and their groups.
  Create: 'ایجاد',
  Delete: 'حذف',
  Find: 'خواندن',
  Update: 'به‌روزرسانی',
  Tools: 'ابزارها',
  Resources: 'منابع',
  Prompts: 'پرامپت‌ها',
  'Experimental Tools': 'ابزارهای آزمایشی',
  // plugin-mcp — experimental auth tools (disabled unless enabled explicitly).
  'Check Auth Status': 'بررسی وضعیت ورود',
  'Email Verification': 'تأیید ایمیل',
  'Forgot Password': 'فراموشی رمز عبور',
  'Reset Password': 'بازنشانی رمز عبور',
  'Unlock Account': 'رفع قفل حساب',
  'User Login': 'ورود کاربر',
  // plugin-mcp — one collapsible per enabled collection/global, labelled from its slug.
  Categories: 'دسته‌بندی‌ها',
  Footer: 'پابرگ',
  Forms: 'فرم‌ها',
  Header: 'سربرگ',
  Media: 'رسانه',
  Pages: 'برگه‌ها',
  PayloadFolders: 'پوشه‌ها',
  Posts: 'نوشته‌ها',
  Products: 'محصول‌ها',
  SiteBranding: 'هویت بصری',
  Store: 'فروشگاه',
  // plugin-mcp — the group label is the config type, lowercased.
  collection: 'مجموعه',
  global: 'سراسری',
  // plugin-nested-docs — the breadcrumbs field and its rows.
  Breadcrumbs: 'مسیر راهنما',
  Doc: 'سند',
  URL: 'نشانی',
}

const DESCRIPTIONS: Record<string, string> = {
  // plugin-mcp — the API key fields.
  'A useful label for the API key.': 'برچسبی گویا برای این کلید.',
  'The purpose of the API key.': 'کاربرد این کلید.',
  'The user that the API key is associated with.': 'کاربری که این کلید به آن تعلق دارد.',
  'API keys control which collections, resources, tools, and prompts MCP clients can access':
    'کلید API تعیین می‌کند کلاینت‌های MCP به کدام مجموعه‌ها، منابع، ابزارها و پرامپت‌ها دسترسی داشته باشند.',
  // plugin-mcp — capability groups.
  'Manage client access to tools': 'دسترسی کلاینت به ابزارها',
  'Manage client access to resources': 'دسترسی کلاینت به منابع',
  'Manage client access to prompts': 'دسترسی کلاینت به پرامپت‌ها',
  'Manage client access to experimental tools': 'دسترسی کلاینت به ابزارهای آزمایشی',
  // plugin-mcp — per-operation hints.
  'Authenticates a user with email and password.': 'کاربر را با ایمیل و رمز عبور احراز هویت می‌کند.',
  'Checks authentication status for the current user.': 'وضعیت احراز هویت کاربر فعلی را بررسی می‌کند.',
  'Create a document in a collection.': 'ایجاد یک سند در مجموعه.',
  'Delete documents in a collection by ID or where clause.': 'حذف سندها بر اساس شناسه یا شرط.',
  'Find a Payload global singleton configuration.': 'خواندن تنظیمات یک گلوبال.',
  'Find documents in a collection by ID or where clause using Find or FindByID.':
    'یافتن سندها در مجموعه بر اساس شناسه یا شرط.',
  'Resets a user password with a reset token.': 'رمز عبور را با توکن بازنشانی تغییر می‌دهد.',
  'Sends a password reset email to a user.': 'ایمیل بازنشانی رمز عبور را برای کاربر می‌فرستد.',
  'Unlocks a user account that has been locked due to failed login attempts.':
    'حسابی را که پس از تلاش‌های ناموفق قفل شده باز می‌کند.',
  'Update a Payload global singleton configuration.': 'به‌روزرسانی تنظیمات یک گلوبال.',
  'Update documents in a collection by ID or where clause.': 'به‌روزرسانی سندها بر اساس شناسه یا شرط.',
  'Verifies a user email with a verification token.': 'ایمیل کاربر را با توکن تأیید می‌کند.',
}

/**
 * Labels for fields that carry no label at all, keyed on the field name. Payload
 * humanises an unlabeled name at render time (`breadcrumbs` → “Breadcrumbs”), which no
 * dictionary can intercept, so nested-docs' added field is named here instead.
 */
const NAMES: Record<string, string> = {
  breadcrumbs: 'مسیر راهنما',
  doc: 'سند',
  label: 'برچسب',
  url: 'نشانی',
}

type Localizable = {
  [key: string]: unknown
  admin?: Record<string, unknown>
  blocks?: unknown[]
  description?: unknown
  fields?: unknown[]
  labels?: Record<string, unknown>
  name?: unknown
  options?: unknown[]
  tabs?: unknown[]
}

const translate = (value: unknown, dictionary: Record<string, string>): unknown =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(dictionary, value)
    ? dictionary[value]
    : value

/** Translate one field, its `admin.description` and everything nested inside it. */
const localizeField = <T>(input: T): T => {
  if (!input || typeof input !== 'object') return input

  const field: Localizable = { ...(input as Localizable) }

  if (
    field.label === undefined &&
    typeof field.name === 'string' &&
    Object.prototype.hasOwnProperty.call(NAMES, field.name)
  ) {
    // Only names this module knows: any other unlabeled field is better left to
    // Payload's own humanised name than given a raw `field.name` as its label.
    field.label = NAMES[field.name]
  } else {
    field.label = translate(field.label, LABELS)
  }
  field.description = translate(field.description, DESCRIPTIONS)

  if (field.labels && typeof field.labels === 'object') {
    field.labels = { ...field.labels }
    field.labels.singular = translate(field.labels.singular, LABELS)
    field.labels.plural = translate(field.labels.plural, LABELS)
  }

  if (field.admin && typeof field.admin === 'object') {
    field.admin = {
      ...field.admin,
      description: translate(field.admin.description, DESCRIPTIONS),
    }
  }

  if (Array.isArray(field.fields)) {
    field.fields = field.fields.map(localizeField)
  }
  if (Array.isArray(field.tabs)) {
    field.tabs = field.tabs.map((tab) =>
      tab && typeof tab === 'object' && Array.isArray((tab as Localizable).fields)
        ? { ...(tab as Localizable), fields: ((tab as Localizable).fields as unknown[]).map(localizeField) }
        : tab,
    )
  }
  if (Array.isArray(field.blocks)) {
    field.blocks = field.blocks.map((block) =>
      block && typeof block === 'object' && Array.isArray((block as Localizable).fields)
        ? {
            ...(block as Localizable),
            fields: ((block as Localizable).fields as unknown[]).map(localizeField),
          }
        : block,
    )
  }
  if (Array.isArray(field.options)) {
    field.options = field.options.map((option) =>
      option && typeof option === 'object' && 'label' in (option as Localizable)
        ? { ...(option as Localizable), label: translate((option as Localizable).label, LABELS) }
        : option,
    )
  }

  return field as unknown as T
}

/**
 * Which fields of which collection this module is allowed to touch. A collection
 * missing from here is returned untouched, fields and chrome alike.
 *
 * `mcp` walks everything, because the whole `payload-mcp-api-keys` collection is the
 * plugin's own output. `nestedDocs` is bounded to the one field it injects, so an
 * editor's own `categories` labels keep whatever they say.
 */
const TARGETS: Record<string, (field: Field) => boolean> = {
  [MCP_API_KEYS_SLUG]: () => true,
  categories: (field) => 'name' in field && field.name === NESTED_DOCS_FIELD,
}

const localizeCollection = (collection: CollectionConfig): CollectionConfig => {
  const matches = TARGETS[collection.slug]
  if (!matches) return collection

  const admin = collection.admin
  return {
    ...collection,
    fields: collection.fields.map((field) => (matches(field) ? localizeField(field) : field)),
    ...(collection.slug === MCP_API_KEYS_SLUG && admin
      ? {
          admin: {
            ...admin,
            description: translate(admin.description, DESCRIPTIONS) as string | undefined,
          },
        }
      : {}),
  }
}

/**
 * Runs after the plugins whose output it translates (`nestedDocs`, `mcp`). Globals are
 * left alone: neither plugin injects one into the admin.
 */
export const faAdminLabels: Plugin = (config) => ({
  ...config,
  collections: (config.collections ?? []).map(localizeCollection),
})
