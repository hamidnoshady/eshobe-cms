import type { CollectionConfig, NumberFieldSingleValidation } from 'payload'

import { slugField, validations } from 'payload'

import { authenticated } from '../access/authenticated'
import { authenticatedOrPublished } from '../access/authenticatedOrPublished'
import { apiKeyAware, apiKeyCreateAware, apiKeyUpdateAware, forceApiKeySite, forceApiKeySiteBeforeValidate } from '../access/siteApiKey'
import { scopedPublishedRead } from '../access/siteRead'
import { writeUnlessPublishing } from '../access/publish'
import { PRODUCTS_BASE } from '@/lib/slug'
import { slugifyField } from '@/lib/slug'

import { hiddenFromOperators } from '@/admin/visibility'
import { generatePreviewPath } from '../utilities/generatePreviewPath'
import { revalidateSiteDoc, revalidateSiteDocDelete } from '../hooks/revalidateSiteDoc'
import { uniqueSlugPerSite } from '../hooks/uniqueSlugPerSite'
import { validatePriceMinor } from '../lib/money'
import { enforceQuota } from '@/collections/hooks/enforceQuota'
import { migrationSourceField } from './fields/migrationSource'
import { menuSourceFields } from './fields/menuSource'
import { validateMenuSource } from './hooks/validateMenuSource'
import { validateProductCommerce } from './hooks/validateProductCommerce'

const validateInventory: NumberFieldSingleValidation = (value, options) => {
  const data = options.data as { menuSourceSystem?: string | null } | undefined
  return validations.number(value, { ...options, required: data?.menuSourceSystem === 'biza_miz' ? false : options.required })
}

/**
 * The catalogue of a `store` site: one product, one price, buyable straight from
 * the page that lists it.
 *
 * Deliberately *not* `@payloadcms/plugin-ecommerce` — see `WAVE-7.md`. The spike
 * measured that plugin's `products` collection as `site, inventory, enableVariants,
 * variantTypes, variants, priceIn<CURRENCY>[Enabled], _status`: no title, no copy,
 * no image, nothing localized. The content model had to be written either way, and
 * what the plugin would have added on top of it is a cart, a customer model that
 * cannot exist on this platform, and checkout code that is not tenant-scoped.
 *
 * Prices are integers in the site's minor currency unit — see `src/lib/money.ts`.
 * There is no `currency` field here on purpose: one site, one currency, and a
 * per-product unit would be a second answer to the Toman/Rial question.
 */
export const Products: CollectionConfig<'products'> = {
  slug: 'products',
  // PostgreSQL treats NULLs as distinct, so native products remain unrestricted.
  // Keep this in the schema as well as the migration: dev schema pushes must not
  // discard the retry-safe POS identity constraint.
  indexes: [{ fields: ['site', 'menuSourceSystem', 'menuSourceId'], unique: true }],
  access: {
    // A site API key (WAVE-9 §9.4) is that site's own headless client — full
    // catalogue read/write for the one site the key names, never a publish.
    // `forceApiKeySite` (below) is what stops a create/update from naming a
    // *different* site than the key's own.
    create: apiKeyCreateAware(writeUnlessPublishing('products')),
    delete: apiKeyAware(authenticated),
    // Public for published rows only, and always scoped: the storefront reads this
    // through `findForSite`, which adds the `site` constraint. `draft: true` does not
    // filter drafts — this where-clause is what does.
    read: apiKeyAware(scopedPublishedRead(authenticatedOrPublished)),
    update: apiKeyUpdateAware(writeUnlessPublishing('products')),
  },
  admin: {
    defaultColumns: ['title', 'slug', 'price', 'inventory', 'updatedAt'],
    description: 'قیمت‌ها بر حسب واحد پولِ خودِ این سایت نوشته می‌شود.',
    group: 'فروشگاه',
    hidden: hiddenFromOperators,
    useAsTitle: 'title',
    livePreview: {
      url: ({ data, req }) => generatePreviewPath({ base: PRODUCTS_BASE, data, req }),
    },
    preview: (data, { req }) => generatePreviewPath({ base: PRODUCTS_BASE, data, req }),
  },
  labels: {
    singular: 'محصول',
    plural: 'محصول‌ها',
  },
  defaultPopulate: {
    title: true,
    slug: true,
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      label: 'عنوان',
      required: true,
      localized: true,
    },
    slugField({ slugify: slugifyField, localized: true, disableUnique: true }),
    {
      name: 'summary',
      type: 'textarea',
      label: 'توضیح کوتاه',
      localized: true,
      admin: {
        description: 'زیر عنوان در کارت محصول نمایش داده می‌شود.',
      },
    },
    {
      name: 'image',
      type: 'upload',
      label: 'تصویر',
      relationTo: 'media',
      // Not required: a product with no photo yet is a normal state for a store being
      // set up, and blocking the save would push editors into inventing filler.
      // `Media` renders an empty tile, so the card keeps its shape either way.
      // ponytail: also what lets the seed and the int fixtures build a catalogue —
      // real uploads land with the storage adapter (Wave 6).
    },
    {
      type: 'row',
      fields: [
        {
          name: 'price',
          type: 'number',
          label: 'قیمت',
          required: true,
          min: 0,
          admin: {
            description: 'عدد صحیح، بر حسب واحد پول این سایت (پیش‌فرض: تومان).',
            width: '50',
          },
          validate: validatePriceMinor,
        },
        {
          name: 'compareAtPrice',
          type: 'number',
          label: 'قیمت پیشین',
          min: 0,
          admin: {
            description: 'اختیاری؛ با خط‌خوردگی کنار قیمت نمایش داده می‌شود.',
            width: '50',
          },
          validate: validatePriceMinor,
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'sku',
          type: 'text',
          label: 'کد کالا',
          admin: {
            description: 'برای خودتان؛ روی سایت نمایش داده نمی‌شود.',
            width: '50',
          },
          index: true,
        },
        {
          name: 'trackInventory',
          type: 'checkbox',
          label: 'موجودی را بشمار',
          admin: {
            description: 'خاموش یعنی «همیشه موجود».',
            width: '50',
          },
          defaultValue: false,
        },
      ],
    },
    {
      name: 'inventory',
      type: 'number',
      label: 'موجودی',
      min: 0,
      admin: {
        condition: (_, siblingData) => Boolean(siblingData?.trackInventory),
        description: 'برای کالاهای عادی با پرداخت کم می‌شود؛ موجودی منوی مبدأ فقط همگام‌سازی می‌شود.',
      },
      // Native tracked stock still requires a count. A POS may temporarily
      // report an unknown count; keep it null and fail closed at checkout rather
      // than inventing zero or turning tracking off.
      required: true,
      validate: validateInventory,
    },
    {
      name: 'body',
      type: 'richText',
      label: 'توضیح کامل',
      localized: true,
    },
    {
      name: 'productType',
      type: 'select',
      label: 'گونه محصول',
      admin: {
        description:
          'ساده مستقیم خریده می‌شود؛ متغیر از روی تنوع‌ها؛ گروهی چند محصول را کنار هم می‌گذارد؛ خارجی به نشانی بیرونی می‌رود و در سبد ای‌شوب فروخته نمی‌شود.',
      },
      defaultValue: 'simple',
      options: [
        { label: 'ساده', value: 'simple' },
        { label: 'متغیر (با تنوع)', value: 'variable' },
        { label: 'گروهی', value: 'grouped' },
        { label: 'خارجی/وابسته', value: 'external' },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'virtual', type: 'checkbox', label: 'مجازی (بدون ارسال)', admin: { width: '50' }, defaultValue: false },
        { name: 'downloadable', type: 'checkbox', label: 'دانلودی', admin: { width: '50' }, defaultValue: false },
      ],
    },
    {
      name: 'externalUrl',
      type: 'text',
      label: 'نشانی محصول خارجی',
      admin: { condition: (_data, siblingData) => siblingData?.productType === 'external' },
    },
    {
      name: 'buttonText',
      type: 'text',
      label: 'متن دکمه خارجی',
      admin: { condition: (_data, siblingData) => siblingData?.productType === 'external' },
      localized: true,
    },
    {
      name: 'groupedProducts',
      type: 'relationship',
      label: 'محصول‌های گروه',
      admin: { condition: (_data, siblingData) => siblingData?.productType === 'grouped' },
      hasMany: true,
      relationTo: 'products',
    },
    {
      name: 'gallery',
      type: 'upload',
      label: 'نگارخانه',
      hasMany: true,
      relationTo: 'media',
    },
    {
      name: 'attributes',
      type: 'array',
      label: 'ویژگی‌ها',
      labels: { plural: 'ویژگی‌ها', singular: 'ویژگی' },
      fields: [
        { name: 'key', type: 'text', label: 'کلید', required: true },
        { name: 'name', type: 'text', label: 'نام', localized: true, required: true },
        { name: 'visible', type: 'checkbox', label: 'نمایش در صفحه محصول', defaultValue: true },
        { name: 'usedForVariation', type: 'checkbox', label: 'استفاده در تنوع', defaultValue: false },
        {
          name: 'options',
          type: 'array',
          label: 'گزینه‌ها',
          labels: { plural: 'گزینه‌ها', singular: 'گزینه' },
          fields: [{ name: 'value', type: 'text', label: 'مقدار', localized: true, required: true }],
        },
      ],
    },
    {
      name: 'variations',
      type: 'array',
      label: 'تنوع‌ها',
      admin: {
        condition: (_data, siblingData) => siblingData?.productType === 'variable',
        description: 'خرید با «کلید» هر تنوع انجام می‌شود و سطر سفارش همان کلید و قیمت زمان خرید را نگه می‌دارد.',
      },
      labels: { plural: 'تنوع‌ها', singular: 'تنوع' },
      fields: [
        { name: 'key', type: 'text', label: 'کلید پایدار', index: true },
        { name: 'label', type: 'text', label: 'برچسب', localized: true },
        { name: 'sku', type: 'text', label: 'کد کالا', index: true },
        { name: 'price', type: 'number', label: 'قیمت', min: 0, required: true, validate: validatePriceMinor },
        { name: 'compareAtPrice', type: 'number', label: 'قیمت پیشین', min: 0, validate: validatePriceMinor },
        { name: 'trackInventory', type: 'checkbox', label: 'موجودی جدا بشمار', defaultValue: false },
        {
          name: 'inventory',
          type: 'number',
          label: 'موجودی تنوع',
          admin: { condition: (_data, siblingData) => Boolean(siblingData?.trackInventory) },
          min: 0,
        },
        { name: 'image', type: 'upload', label: 'تصویر تنوع', relationTo: 'media' },
        {
          name: 'attributeValues',
          type: 'json',
          label: 'مقادیر ویژگی‌ها',
          admin: { description: 'نگاشت کلید ویژگی به گزینه انتخاب‌شده؛ مثل {"color":"قرمز"}.' },
        },
        { name: 'active', type: 'checkbox', label: 'فعال', defaultValue: true },
        { name: 'weight', type: 'text', label: 'وزن' },
        { name: 'sourceId', type: 'text', label: 'شناسه تنوع در مبدأ', index: true },
        { name: 'sourceStatus', type: 'text', label: 'وضعیت در مبدأ' },
      ],
    },
    ...menuSourceFields(),
    {
      name: 'externalInventory',
      type: 'checkbox',
      label: 'موجودی در سامانهٔ مبدأ مدیریت می‌شود',
      defaultValue: false,
      admin: {
        description: 'موجودی کالا فقط تصویری از سامانهٔ مبدأ است؛ پرداخت در ای‌شوب آن را کم نمی‌کند.',
        readOnly: true,
      },
    },
    {
      name: 'menuAvailability',
      type: 'select',
      label: 'وضعیت عرضه در منو',
      defaultValue: 'available',
      options: [
        { label: 'قابل سفارش', value: 'available' },
        { label: 'تمام شده', value: 'sold_out' },
        { label: 'غیرفعال', value: 'unavailable' },
      ],
    },
    {
      name: 'menuOrder',
      type: 'number',
      label: 'ترتیب در منو',
      defaultValue: 0,
      admin: { step: 1 },
    },
    {
      name: 'modifierGroups',
      type: 'array',
      label: 'گروه‌های افزودنی منو',
      maxRows: 50,
      labels: { plural: 'گروه‌های افزودنی', singular: 'گروه افزودنی' },
      admin: { description: 'افزودنی‌ها از تنوع‌های محصول جدا هستند؛ شناسه‌ها از سامانهٔ مبدأ می‌آیند.' },
      fields: [
        { name: 'sourceId', type: 'text', label: 'شناسهٔ پایدار گروه', required: true, maxLength: 128 },
        { name: 'label', type: 'text', label: 'عنوان گروه', localized: true, required: true },
        { name: 'minSelections', type: 'number', label: 'کمترین انتخاب', defaultValue: 0, min: 0, max: 100, required: true },
        { name: 'maxSelections', type: 'number', label: 'بیشترین انتخاب', defaultValue: 1, min: 1, max: 100, required: true },
        { name: 'active', type: 'checkbox', label: 'فعال', defaultValue: true },
        { name: 'menuOrder', type: 'number', label: 'ترتیب نمایش', defaultValue: 0 },
        {
          name: 'options',
          type: 'array',
          label: 'گزینه‌های افزودنی',
          maxRows: 100,
          labels: { plural: 'گزینه‌ها', singular: 'گزینه' },
          fields: [
            { name: 'sourceId', type: 'text', label: 'شناسهٔ پایدار گزینه', required: true, maxLength: 128 },
            { name: 'label', type: 'text', label: 'عنوان گزینه', localized: true, required: true },
            {
              name: 'priceDelta',
              type: 'number',
              label: 'تغییر قیمت (واحد خرد)',
              defaultValue: 0,
              required: true,
              validate: (value: unknown) =>
                typeof value === 'number' && Number.isSafeInteger(value)
                  ? true
                  : 'تغییر قیمت باید عدد صحیح در واحد خرد باشد.',
            },
            { name: 'active', type: 'checkbox', label: 'فعال', defaultValue: true },
            { name: 'menuOrder', type: 'number', label: 'ترتیب نمایش', defaultValue: 0 },
          ],
        },
      ],
    },
    {
      name: 'terms',
      type: 'relationship',
      label: 'واژه‌های طبقه‌بندی',
      admin: {
        description: 'دسته/برچسب محصول و دیگر طبقه‌بندی‌ها؛ هر واژه طبقه‌بندی خودش را دارد و با دسته نوشته‌ها قاطی نمی‌شود.',
      },
      hasMany: true,
      relationTo: 'taxonomy-terms',
    },
    {
      type: 'row',
      fields: [
        {
          name: 'upsells',
          type: 'relationship',
          label: 'فروش مکمل (upsell)',
          admin: { width: '50' },
          hasMany: true,
          relationTo: 'products',
        },
        {
          name: 'crossSells',
          type: 'relationship',
          label: 'فروش جانبی (cross-sell)',
          admin: { width: '50' },
          hasMany: true,
          relationTo: 'products',
        },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'weight', type: 'text', label: 'وزن', admin: { width: '25' } },
        { name: 'length', type: 'text', label: 'طول', admin: { width: '25' } },
        { name: 'width', type: 'text', label: 'عرض', admin: { width: '25' } },
        { name: 'height', type: 'text', label: 'ارتفاع', admin: { width: '25' } },
      ],
    },
    { name: 'metaTitle', type: 'text', label: 'عنوان سئو', localized: true },
    { name: 'metaDescription', type: 'textarea', label: 'توضیح سئو', localized: true },
    { name: 'canonicalUrl', type: 'text', label: 'نشانی کانونی' },
    { name: 'noindex', type: 'checkbox', label: 'در موتور جست‌وجو نمایه نشود', defaultValue: false },
    migrationSourceField({ optional: true }),
  ],
  versions: {
    drafts: {
      /** Same interval as pages — see the note in `src/collections/Pages/index.ts`. */
      autosave: { interval: 375 },
    },
    maxPerDoc: 25,
  },
  hooks: {
    afterChange: [revalidateSiteDoc(PRODUCTS_BASE)],
    afterDelete: [revalidateSiteDocDelete(PRODUCTS_BASE)],
    // Access only checked that a site key exists — never trust the payload's own
    // `site` value on a key-authorized write.
    beforeChange: [forceApiKeySite],
    beforeValidate: [forceApiKeySiteBeforeValidate, enforceQuota('products'), uniqueSlugPerSite, validateMenuSource, validateProductCommerce],
  },
}
