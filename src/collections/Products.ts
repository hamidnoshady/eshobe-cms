import type { CollectionConfig } from 'payload'

import { slugField } from 'payload'

import { authenticated } from '../access/authenticated'
import { authenticatedOrPublished } from '../access/authenticatedOrPublished'
import { apiKeyAware, apiKeyCreateAware, apiKeyUpdateAware, forceApiKeySite } from '../access/siteApiKey'
import { scopedPublishedRead } from '../access/siteRead'
import { writeUnlessPublishing } from '../access/publish'
import { PRODUCTS_BASE } from '@/lib/slug'
import { slugifyField } from '@/lib/slug'

import { generatePreviewPath } from '../utilities/generatePreviewPath'
import { revalidateSiteDoc, revalidateSiteDocDelete } from '../hooks/revalidateSiteDoc'
import { uniqueSlugPerSite } from '../hooks/uniqueSlugPerSite'
import { validatePriceMinor } from '../lib/money'

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
        description: 'با پرداخت موفق هر سفارش به اندازهٔ تعدادش کم می‌شود.',
      },
      // `required` here is conditional by construction: Payload does not validate a
      // field its `admin.condition` has hidden, so the count is only demanded when
      // `trackInventory` is on. An empty count must not read as "unlimited" — that
      // is what the checkbox is for.
      required: true,
    },
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
    beforeValidate: [uniqueSlugPerSite],
  },
}
