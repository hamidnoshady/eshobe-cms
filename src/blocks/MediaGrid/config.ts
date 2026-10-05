import type { Block } from 'payload'

import { TENANT_MEDIA_UPLOAD_FIELD } from '@/admin/fields/mediaUploadComponentPath'
import { mediaAspectOptions } from '@/blocks/MediaBlock/config'

/**
 * Several photographs side by side inside an article — a plan beside its section, a
 * set of renders. One shared frame ratio, so the row reads as a composed set.
 * Rich-text only (stored as JSON in the field), so it needs no migration.
 */
export const MediaGrid: Block = {
  slug: 'mediaGrid',
  interfaceName: 'MediaGridBlock',
  labels: { plural: 'ردیف‌های تصویر', singular: 'ردیف تصاویر' },
  fields: [
    {
      name: 'images',
      type: 'upload',
      label: 'تصاویر',
      hasMany: true,
      maxRows: 12,
      minRows: 2,
      relationTo: 'media',
      required: true,
      admin: { components: { Field: TENANT_MEDIA_UPLOAD_FIELD } },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'columns',
          type: 'select',
          label: 'ستون‌ها',
          defaultValue: '2',
          admin: { width: '33%' },
          options: [
            { label: '۲', value: '2' },
            { label: '۳', value: '3' },
            { label: '۴', value: '4' },
          ],
        },
        {
          name: 'aspect',
          type: 'select',
          label: 'نسبت قاب',
          defaultValue: '4/5',
          admin: { width: '33%' },
          // `original` would make a ragged row; a grid always shares one ratio.
          options: mediaAspectOptions.filter((option) => option.value !== 'original' && option.value !== 'auto'),
        },
        { name: 'caption', type: 'text', label: 'زیرنویس', admin: { width: '34%' } },
      ],
    },
  ],
}
