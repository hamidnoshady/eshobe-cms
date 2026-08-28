import type { CollectionConfig } from 'payload'

import {
  FixedToolbarFeature,
  InlineToolbarFeature,
  lexicalEditor,
} from '@payloadcms/richtext-lexical'
import path from 'path'
import { fileURLToPath } from 'url'

import { anyone } from '../access/anyone'
import { scopedPublicRead } from '../access/siteRead'
import { authenticated } from '../access/authenticated'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export const Media: CollectionConfig = {
  slug: 'media',
  folders: true,
  access: {
    create: authenticated,
    delete: authenticated,
    // Public and host-scoped: a media library belongs to one customer, and its file
    // route is served on their domain (`/api/media/file/*` is a Caddy carve-out).
    read: scopedPublicRead(anyone),
    update: authenticated,
  },
  labels: {
    singular: 'رسانه',
    plural: 'رسانه‌ها',
  },
  fields: [
    {
      name: 'alt',
      type: 'text',
      label: 'متن جایگزین',
      //required: true,
      // Alt text is read out by screen readers in the page's language.
      localized: true,
    },
    {
      name: 'caption',
      type: 'richText',
      label: 'توضیح',
      localized: true,
      editor: lexicalEditor({
        features: ({ rootFeatures }) => {
          return [...rootFeatures, FixedToolbarFeature(), InlineToolbarFeature()]
        },
      }),
    },
  ],
  upload: {
    // Dev: public/media in the repo. Production: MEDIA_DIR, an absolute path the
    // compose file mounts as a volume — inside the standalone bundle a relative
    // resolve lands in .next/, which is wiped on every image rebuild. Files are
    // always *served* through /api/media/file/*, so the location is private.
    staticDir: process.env.MEDIA_DIR || path.resolve(dirname, '../../public/media'),
    adminThumbnail: 'thumbnail',
    focalPoint: true,
    imageSizes: [
      {
        name: 'thumbnail',
        width: 300,
      },
      {
        name: 'square',
        width: 500,
        height: 500,
      },
      {
        name: 'small',
        width: 600,
      },
      {
        name: 'medium',
        width: 900,
      },
      {
        name: 'large',
        width: 1400,
      },
      {
        name: 'xlarge',
        width: 1920,
      },
      {
        name: 'og',
        width: 1200,
        height: 630,
        crop: 'center',
      },
    ],
  },
}
