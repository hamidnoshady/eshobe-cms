import type { CollectionConfig } from 'payload'

import { hiddenFromOperators, SITE_CONTENT_GROUP } from '@/admin/visibility'
import { anyone } from '../access/anyone'
import { authenticated } from '../access/authenticated'
import { apiKeyAware, apiKeyCreateAware, apiKeyUpdateAware, forceApiKeySite } from '../access/siteApiKey'
import { scopedPublicRead } from '../access/siteRead'
import {
  archiveSlugMessage,
  DEFAULT_PERMALINK_TEMPLATE,
  isMachineKey,
  isValidArchiveSlug,
  machineKeyMessage,
  PERMALINK_TEMPLATES,
} from '@/lib/content-paths'
import {
  CUSTOM_FIELD_RELATION_COLLECTIONS,
  CUSTOM_FIELD_TYPE_OPTIONS,
} from '@/lib/custom-fields'
import { migrationSourceField } from './fields/migrationSource'
import { uniqueArchiveSlugPerSite, uniqueKeyPerSite } from './hooks/uniqueContentKeys'
import { validateContentTypeDefinition } from './hooks/validateContentTypeDefinition'

/**
 * A site-defined content type (issue #166 §2) — the destination for a
 * WordPress CPT definition, and equally a type a site creates natively.
 *
 * One generic engine (`content-entries`) serves every type; this row carries
 * what makes types differ: labels, hierarchy, the archive base/permalink
 * template its URLs use, the taxonomies its entries may file under, and the
 * typed `fieldSchema` every entry's `fieldValues` is validated against
 * (`src/lib/custom-fields.ts`). No Payload collection is generated per type
 * at runtime — definitions are data, editable per tenant, versioned by row.
 */
export const ContentTypeDefinitions: CollectionConfig = {
  slug: 'content-type-definitions',
  access: {
    create: apiKeyCreateAware(authenticated),
    delete: apiKeyAware(authenticated),
    // Public on purpose: a renderer needs the schema to label and lay out the
    // entries it is allowed to see. The provenance group's raw payload locks
    // its own read (`migrationSourceField`).
    read: scopedPublicRead(anyone),
    update: apiKeyUpdateAware(authenticated),
  },
  admin: {
    defaultColumns: ['key', 'pluralLabel', 'hierarchical', 'archiveSlug', 'updatedAt'],
    description:
      'گونه‌های محتوای سفارشی سایت (معادل CPT وردپرس). رکوردها در «محتوای سفارشی» با همین تعریف‌ها ساخته و ویرایش می‌شوند.',
    group: SITE_CONTENT_GROUP,
    hidden: hiddenFromOperators,
    useAsTitle: 'pluralLabel',
  },
  labels: {
    plural: 'گونه‌های محتوا',
    singular: 'گونه محتوا',
  },
  fields: [
    {
      name: 'key',
      type: 'text',
      label: 'کلید ماشینی',
      admin: {
        description: 'شناسه پایدار گونه در نگاشت و قالب؛ مثل portfolio. بعد از ورود داده تغییر نکند.',
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
          label: 'سلسله‌مراتبی (رکورد والد دارد)',
          admin: { width: '50' },
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
          'بخش نخست نشانی این گونه؛ مثل «نمونه-کار» در /نمونه-کار/خانه-دریا/. خالی یعنی همان کلید ماشینی.',
      },
      localized: true,
      validate: (value: string | null | undefined) =>
        !value || isValidArchiveSlug(value) ? true : archiveSlugMessage,
    },
    {
      name: 'permalinkTemplate',
      type: 'select',
      label: 'قالب پیوسته‌نشانی رکورد',
      admin: {
        description: 'نشانی هر رکورد چطور ساخته شود؛ {archive} همان بخش نشانی بایگانی بالاست.',
      },
      defaultValue: DEFAULT_PERMALINK_TEMPLATE,
      options: PERMALINK_TEMPLATES.map((template) => ({ label: template, value: template })),
      required: true,
    },
    {
      name: 'taxonomies',
      type: 'relationship',
      label: 'طبقه‌بندی‌های این گونه',
      admin: {
        description: 'رکوردهای این گونه فقط زیر واژه‌های همین طبقه‌بندی‌ها پرونده می‌شوند.',
      },
      hasMany: true,
      relationTo: 'taxonomy-definitions',
    },
    {
      name: 'fieldSchema',
      type: 'array',
      label: 'فیلدهای سفارشی',
      admin: {
        description:
          'طرح تایپ‌دار مقادیر رکوردها (معادل گروه فیلد ACF). مقادیر ناشناخته هنگام ورود گم نمی‌شوند؛ در «فراداده نگاشت‌نشده» رکورد می‌مانند.',
      },
      labels: { plural: 'فیلدها', singular: 'فیلد' },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'key',
              type: 'text',
              label: 'کلید فیلد',
              admin: { width: '50' },
              required: true,
            },
            {
              name: 'label',
              type: 'text',
              label: 'برچسب',
              admin: { width: '50' },
              required: true,
            },
          ],
        },
        {
          name: 'fieldType',
          type: 'select',
          label: 'نوع فیلد',
          defaultValue: 'text',
          options: CUSTOM_FIELD_TYPE_OPTIONS,
          required: true,
        },
        {
          type: 'row',
          fields: [
            {
              name: 'required',
              type: 'checkbox',
              label: 'الزامی',
              admin: { width: '50' },
              defaultValue: false,
            },
            {
              name: 'searchable',
              type: 'checkbox',
              label: 'قابل جست‌وجو/پالایش متنی',
              admin: { width: '50' },
              defaultValue: false,
            },
          ],
        },
        {
          name: 'optionsText',
          type: 'textarea',
          label: 'گزینه‌ها',
          admin: {
            condition: (_data, siblingData) =>
              siblingData?.fieldType === 'select' || siblingData?.fieldType === 'multiselect',
            description: 'در هر خط یک گزینه: «مقدار|برچسب» یا فقط مقدار.',
          },
        },
        {
          name: 'relationTo',
          type: 'select',
          label: 'مجموعه مقصد رابطه',
          admin: {
            condition: (_data, siblingData) => siblingData?.fieldType === 'relationship',
          },
          options: CUSTOM_FIELD_RELATION_COLLECTIONS.map((slug) => ({ label: slug, value: slug })),
        },
        {
          name: 'subSchema',
          type: 'json',
          label: 'زیرطرح فیلدها (گروه/تکرارشونده)',
          admin: {
            condition: (_data, siblingData) =>
              siblingData?.fieldType === 'group' || siblingData?.fieldType === 'repeater',
            description:
              'فهرست JSON تعریف فیلدهای داخلی، با همان کلیدهای همین فرم (key/label/fieldType/...).',
          },
        },
        {
          name: 'helpText',
          type: 'textarea',
          label: 'راهنمای ویراستار',
        },
      ],
    },
    {
      name: 'entries',
      type: 'join',
      collection: 'content-entries',
      label: 'رکوردهای این گونه',
      on: 'contentType',
    },
    migrationSourceField(),
  ],
  hooks: {
    beforeChange: [forceApiKeySite],
    beforeValidate: [uniqueKeyPerSite, uniqueArchiveSlugPerSite, validateContentTypeDefinition],
  },
}
