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
import { setMediaPrefix } from '../hooks/mediaPrefix'

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
  hooks: {
    // Namespaces the file's key in R2 by site. No-op while uploads are local.
    beforeChange: [setMediaPrefix],
  },
  upload: {
    // Dev: public/media in the repo. Production: MEDIA_DIR, an absolute path the
    // compose file mounts as a volume — inside the standalone bundle a relative
    // resolve lands in .next/, which is wiped on every image rebuild. Files are
    // always *served* through /api/media/file/*, so the location is private.
    staticDir: process.env.MEDIA_DIR || path.resolve(dirname, '../../public/media'),
    adminThumbnail: 'thumbnail',
    focalPoint: true,
    /**
     * What a customer may put in their media library — raster images, and
     * nothing else.
     *
     * This list does two jobs, and the second is the one that matters. Setting
     * `mimeTypes` at all is what switches on Payload's **content-based** check:
     * with the key absent, `checkFileRestrictions` only screens filenames
     * against a list of executable extensions and never looks inside the file,
     * so a `.png` holding markup uploads clean. With it set, the bytes are
     * sniffed (`file-type`) and the detected type — not the browser's
     * `Content-Type`, and not the extension — has to appear below.
     *
     * `image/svg+xml` is deliberately absent, and `image/*` is deliberately not
     * used in its place: the wildcard re-admits SVG by name inside that same
     * check. An SVG is a script-bearing document, and `/api/media/file/*` is a
     * Caddy carve-out serving it from the *customer's own* origin — so an SVG
     * uploaded by any editor of any tenant is stored XSS against that site,
     * its session cookie and its localStorage. Payload's `validateSvg` would
     * screen the obvious payloads, but "sanitised SVG" is a moving target and
     * nothing in this platform needs one: every media field is a photo, a logo
     * or a gallery image (Team, MediaBlock, Gallery, Logos, Testimonials,
     * Features, Products, heroes).
     *
     * The cost, stated plainly: a customer whose logo is an SVG can no longer
     * upload it and must supply a PNG or WebP. Files already stored are not
     * re-validated and keep serving. If a real need for SVG appears, the answer
     * is a sanitising pipeline on the way in, never widening this list.
     */
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'],
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
