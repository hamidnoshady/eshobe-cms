import type { Block } from 'payload'

import { columnsField, sectionIntro } from '../fields'

export const Gallery: Block = {
  slug: 'gallery',
  interfaceName: 'GalleryBlock',
  fields: [
    ...sectionIntro,
    columnsField,
    {
      name: 'images',
      type: 'upload',
      label: 'تصاویر',
      // `hasMany` rather than an array of single uploads: Payload's own multi-upload
      // UI reorders by drag, and the alt text already lives on the media document.
      hasMany: true,
      relationTo: 'media',
      required: true,
    },
  ],
  labels: {
    singular: 'گالری',
    plural: 'گالری‌ها',
  },
}
