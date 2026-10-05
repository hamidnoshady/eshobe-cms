import type { Block, Field } from 'payload'

import { TENANT_MEDIA_UPLOAD_FIELD } from '@/admin/fields/mediaUploadComponentPath'

/**
 * How a photograph sits on the page. Themes read these to apply their own sizing rule
 * (a ratio from a short set plus a viewport-height cap), so an editor composes with
 * intent instead of every image rendering at its exact pixel size and full width.
 * All three are optional: a row saved before they existed renders as `content` / `auto`.
 */
export const mediaSizeField: Field = {
  name: 'size',
  type: 'select',
  label: 'پهنا',
  defaultValue: 'content',
  admin: { width: '33%' },
  options: [
    { label: 'باریک', value: 'narrow' },
    { label: 'هم‌پهنای متن', value: 'content' },
    { label: 'پهن', value: 'wide' },
    { label: 'تمام‌صفحه', value: 'full' },
  ],
}

export const mediaAspectOptions = [
  { label: 'خودکار (بر اساس جهت تصویر)', value: 'auto' },
  { label: 'افقی عریض ۱۶:۹', value: '16/9' },
  { label: 'افقی ۳:۲', value: '3/2' },
  { label: 'افقی ۴:۳', value: '4/3' },
  { label: 'مربع ۱:۱', value: '1/1' },
  { label: 'عمودی ۴:۵', value: '4/5' },
  { label: 'عمودی ۳:۴', value: '3/4' },
  { label: 'نسبت اصلی تصویر', value: 'original' },
]

export const mediaAspectField: Field = {
  name: 'aspect',
  type: 'select',
  label: 'نسبت قاب',
  defaultValue: 'auto',
  admin: {
    description: 'تصویر قاب را پر می‌کند و نقطهٔ کانونی رسانه حفظ می‌شود.',
    width: '33%',
  },
  options: mediaAspectOptions,
}

const mediaField: Field = {
  name: 'media',
  type: 'upload',
  label: 'تصویر',
  relationTo: 'media',
  required: true,
  // Also registered as a Lexical feature, which the generic schema traversal cannot
  // reach — so the tenant media picker is named here explicitly.
  admin: { components: { Field: TENANT_MEDIA_UPLOAD_FIELD } },
}

const presentation = (localizedCaption: boolean): Field => ({
  type: 'row',
  fields: [
    mediaSizeField,
    mediaAspectField,
    {
      name: 'caption',
      type: 'text',
      label: 'زیرنویس',
      // Page layout rows localize their text; inside a rich-text field the whole
      // field is already localized, so the caption must not be localized again.
      localized: localizedCaption,
      admin: { width: '34%' },
    },
  ],
})

const labels = { plural: 'تصاویر', singular: 'تصویر' }

/** Page-layout block (`pages.layout`). */
export const MediaBlock: Block = {
  slug: 'mediaBlock',
  interfaceName: 'MediaBlock',
  labels,
  fields: [mediaField, presentation(true)],
}

/** The same block inside rich text (posts, columns): stored as JSON, caption unlocalized. */
export const MediaBlockInline: Block = {
  slug: 'mediaBlock',
  interfaceName: 'MediaBlockInline',
  labels,
  fields: [mediaField, presentation(false)],
}
