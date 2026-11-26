import type { CollectionConfig } from 'payload'

import { slugField } from 'payload'

import { hiddenFromOperators, SITE_CONTENT_GROUP } from '@/admin/visibility'
import { anyone } from '../access/anyone'
import { authenticated } from '../access/authenticated'
import { apiKeyAware, apiKeyCreateAware, apiKeyUpdateAware, forceApiKeySite, forceApiKeySiteBeforeValidate } from '../access/siteApiKey'
import { scopedPublicRead } from '../access/siteRead'
import { slugifyField } from '@/lib/slug'
import { migrationSourceField } from './fields/migrationSource'
import { menuSourceFields } from './fields/menuSource'
import { validateMenuSource } from './hooks/validateMenuSource'
import { uniqueTermSlugPerTaxonomy } from './hooks/uniqueContentKeys'
import { validateTaxonomyTerm } from './hooks/validateTaxonomyTerm'

/**
 * One term in one taxonomy of one site (issue #166 §2). The stable source key
 * is `(installation, taxonomy, source.sourceId = term_id)` — never the name,
 * which two taxonomies may share; `sourceTermTaxonomyId` additionally keeps
 * WP's `term_taxonomy_id` where the source exposed it, because termmeta and
 * some plugins key on it. Slug uniqueness is per {site, taxonomy, locale}:
 * the same slug under a *different* taxonomy is a different term.
 */
export const TaxonomyTerms: CollectionConfig = {
  slug: 'taxonomy-terms',
  indexes: [{ fields: ['site', 'menuSourceSystem', 'menuSourceId'], unique: true }],
  access: {
    create: apiKeyCreateAware(authenticated),
    delete: apiKeyAware(authenticated),
    read: scopedPublicRead(anyone),
    update: apiKeyUpdateAware(authenticated),
  },
  admin: {
    defaultColumns: ['name', 'slug', 'taxonomy', 'parent', 'updatedAt'],
    description: 'واژه‌های طبقه‌بندی‌ها و برچسب‌ها؛ هر واژه دقیقاً به یک طبقه‌بندی از همین سایت تعلق دارد.',
    group: SITE_CONTENT_GROUP,
    hidden: hiddenFromOperators,
    useAsTitle: 'name',
  },
  labels: {
    plural: 'واژه‌های طبقه‌بندی',
    singular: 'واژه طبقه‌بندی',
  },
  fields: [
    {
      name: 'taxonomy',
      type: 'relationship',
      label: 'طبقه‌بندی',
      index: true,
      relationTo: 'taxonomy-definitions',
      required: true,
    },
    {
      name: 'name',
      type: 'text',
      label: 'نام',
      localized: true,
      required: true,
    },
    slugField({
      disableUnique: true,
      localized: true,
      slugify: slugifyField,
      useAsSlug: 'name',
    }),
    {
      name: 'description',
      type: 'textarea',
      label: 'توضیح',
      localized: true,
    },
    {
      name: 'parent',
      type: 'relationship',
      label: 'واژه والد',
      admin: {
        description: 'فقط در طبقه‌بندی سلسله‌مراتبی، و از همان طبقه‌بندی.',
      },
      index: true,
      relationTo: 'taxonomy-terms',
    },
    {
      type: 'row',
      fields: [
        {
          name: 'menuOrder',
          type: 'number',
          label: 'ترتیب نمایش',
          admin: { width: '50' },
          defaultValue: 0,
        },
        {
          name: 'sourceTermTaxonomyId',
          type: 'text',
          label: 'term_taxonomy_id مبدأ',
          admin: { width: '50' },
          index: true,
        },
      ],
    },
    {
      name: 'legacyArchiveUrl',
      type: 'text',
      label: 'نشانی بایگانی قبلی',
      admin: {
        description: 'نشانی صفحه این واژه روی سایت قدیمی؛ مبنای تغییر مسیر و بررسی پوشش نشانی‌ها.',
      },
    },
    {
      name: 'meta',
      type: 'json',
      label: 'فراداده واژه (termmeta نگاشته‌شده)',
      admin: {
        description: 'فقط فراداده‌ای که آگاهانه برای نمایش نگاشته شده این‌جا بیاید؛ بار خام کامل در منشأ است.',
      },
    },
    {
      name: 'entryRelations',
      type: 'join',
      collection: 'entry-term-relations',
      label: 'رکوردهای پیوسته به این واژه',
      on: 'term',
    },
    ...menuSourceFields(),
    migrationSourceField(),
  ],
  hooks: {
    beforeChange: [forceApiKeySite],
    beforeValidate: [forceApiKeySiteBeforeValidate, validateMenuSource, validateTaxonomyTerm, uniqueTermSlugPerTaxonomy],
  },
}
