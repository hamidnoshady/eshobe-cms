import type { CollectionConfig } from 'payload'

import { hiddenFromOperators, SITE_CONTENT_GROUP } from '@/admin/visibility'
import { anyone } from '../access/anyone'
import { authenticated } from '../access/authenticated'
import { apiKeyAware, apiKeyCreateAware, apiKeyUpdateAware, forceApiKeySite } from '../access/siteApiKey'
import { scopedPublicRead } from '../access/siteRead'
import {
  archiveSlugMessage,
  isMachineKey,
  isValidArchiveSlug,
  machineKeyMessage,
} from '@/lib/content-paths'
import { migrationSourceField } from './fields/migrationSource'
import { uniqueArchiveSlugPerSite, uniqueKeyPerSite } from './hooks/uniqueContentKeys'

/**
 * One named taxonomy of a site (issue #166 §2) — WordPress `category`,
 * `post_tag`, `product_cat` and every custom taxonomy each land as their own
 * row here, never merged into the flat `categories` collection. `hierarchical`
 * is the tags-vs-categories switch WP carries per taxonomy; term rows enforce
 * it (`validateTaxonomyTerm`). Which content types use the taxonomy is
 * declared on the type (`content-type-definitions.taxonomies`), one source of
 * truth instead of two half-synced lists.
 */
export const TaxonomyDefinitions: CollectionConfig = {
  slug: 'taxonomy-definitions',
  access: {
    create: apiKeyCreateAware(authenticated),
    delete: apiKeyAware(authenticated),
    read: scopedPublicRead(anyone),
    update: apiKeyUpdateAware(authenticated),
  },
  admin: {
    defaultColumns: ['key', 'pluralLabel', 'hierarchical', 'archiveSlug', 'updatedAt'],
    description:
      'هر طبقه‌بندی (دسته، برچسب یا گونه سفارشی وردپرس) تعریف جدای خودش را دارد و هیچ‌وقت با دسته‌بندی‌های دیگر ادغام نمی‌شود.',
    group: SITE_CONTENT_GROUP,
    hidden: hiddenFromOperators,
    useAsTitle: 'pluralLabel',
  },
  labels: {
    plural: 'تعریف‌های طبقه‌بندی',
    singular: 'تعریف طبقه‌بندی',
  },
  fields: [
    {
      name: 'key',
      type: 'text',
      label: 'کلید ماشینی',
      admin: {
        description: 'شناسه پایدار طبقه‌بندی در نگاشت و قالب؛ مثل genre یا post_tag. بعد از ورود داده تغییر نکند.',
      },
      index: true,
      required: true,
      validate: (value: string | null | undefined) =>
        !value || isMachineKey(value) ? true : machineKeyMessage,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'singularLabel',
          type: 'text',
          label: 'برچسب مفرد',
          admin: { width: '50' },
          localized: true,
          required: true,
        },
        {
          name: 'pluralLabel',
          type: 'text',
          label: 'برچسب جمع',
          admin: { width: '50' },
          localized: true,
          required: true,
        },
      ],
    },
    {
      name: 'description',
      type: 'textarea',
      label: 'توضیح',
      localized: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'hierarchical',
          type: 'checkbox',
          label: 'سلسله‌مراتبی (دسته‌گونه)',
          admin: {
            description: 'روشن یعنی واژه‌ها والد/فرزند دارند (دسته)؛ خاموش یعنی تخت‌اند (برچسب).',
            width: '50',
          },
          defaultValue: false,
        },
        {
          name: 'hasArchive',
          type: 'checkbox',
          label: 'بایگانی عمومی دارد',
          admin: { width: '50' },
          defaultValue: true,
        },
      ],
    },
    {
      name: 'archiveSlug',
      type: 'text',
      label: 'بخش نشانی بایگانی',
      admin: {
        description:
          'بخش نخست نشانی صفحه‌های این طبقه‌بندی؛ مثل «سبک» در /سبک/مسکونی/. خالی یعنی همان کلید ماشینی.',
      },
      localized: true,
      validate: (value: string | null | undefined) =>
        !value || isValidArchiveSlug(value) ? true : archiveSlugMessage,
    },
    {
      name: 'terms',
      type: 'join',
      collection: 'taxonomy-terms',
      label: 'واژه‌های این طبقه‌بندی',
      on: 'taxonomy',
    },
    migrationSourceField(),
  ],
  hooks: {
    beforeChange: [forceApiKeySite],
    beforeValidate: [uniqueKeyPerSite, uniqueArchiveSlugPerSite],
  },
}
