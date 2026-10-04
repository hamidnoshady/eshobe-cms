import type { Block } from 'payload'

import { TENANT_MEDIA_UPLOAD_FIELD } from '@/admin/fields/mediaUploadComponentPath'

export const MediaBlock: Block = {
  slug: 'mediaBlock',
  interfaceName: 'MediaBlock',
  fields: [
    {
      name: 'media',
      type: 'upload',
      relationTo: 'media',
      required: true,
      // This block is registered as a Lexical feature rather than a Payload
      // `blocks` field, so it cannot be reached by the generic schema traversal.
      // It still shares the exact same tenant media picker as every other field.
      admin: { components: { Field: TENANT_MEDIA_UPLOAD_FIELD } },
    },
  ],
}
