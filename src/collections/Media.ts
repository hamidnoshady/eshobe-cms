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
import { hiddenFromOperators, SITE_CONTENT_GROUP } from '@/admin/visibility'
import { sanitizeSvgUpload } from '@/hooks/sanitizeSvgUpload'
import { adminThumbnailUrl, type PreviewMedia } from '@/lib/mediaPreview'
import {
  accountMediaStorage,
  accountMediaStorageDelete,
} from '@/collections/hooks/accountMediaStorage'
import { enforceQuota } from '@/collections/hooks/enforceQuota'
import { revalidateSiteGlobal, revalidateSiteGlobalDelete } from '@/hooks/revalidateSiteGlobal'
import { migrationSourceField } from './fields/migrationSource'

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
  admin: {
    group: SITE_CONTENT_GROUP,
    hidden: hiddenFromOperators,
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
    migrationSourceField({ optional: true }),
  ],
  hooks: {
    // An SVG is validated against an allowlist (and refused if it carries anything
    // but drawing) before Payload sees the file. See `src/lib/svg.ts`.
    beforeOperation: [sanitizeSvgUpload],
    // Namespaces the file's key in the object-storage bucket by site. No-op while
    // uploads are local.
    beforeChange: [setMediaPrefix],
    afterChange: [accountMediaStorage, revalidateSiteGlobal('media')],
    afterDelete: [accountMediaStorageDelete, revalidateSiteGlobalDelete('media')],
    // Counts files, not bytes — `mediaStorageMb` is metered separately and reported,
    // because refusing an upload mid-stream on a byte total the client cannot see is
    // a worse experience than a file-count limit it can.
    beforeValidate: [enforceQuota('media')],
  },
  upload: {
    // Dev: public/media in the repo. Production: MEDIA_DIR, an absolute path the
    // compose file mounts as a volume — inside the standalone bundle a relative
    // resolve lands in .next/, which is wiped on every image rebuild. Files are
    // always *served* through /api/media/file/*, so the location is private.
    staticDir: process.env.MEDIA_DIR || path.resolve(dirname, '../../public/media'),
    /**
     * An SVG's generated size — when there is one — is a single raster frame. The
     * admin list and branding previews have to point at the original document so
     * its CSS animation runs. Raster uploads keep the small `thumbnail` size.
     */
    adminThumbnail: ({ doc }) =>
      adminThumbnailUrl(doc as unknown as null | PreviewMedia | undefined),
    focalPoint: true,
    /**
     * What a customer may put in their media library — raster images, and SVG that
     * has passed the allowlist in `src/lib/svg.ts`.
     *
     * This list does two jobs. Setting `mimeTypes` at all is what switches on
     * Payload's **content-based** check: with the key absent, `checkFileRestrictions`
     * only screens filenames against a list of executable extensions and never looks
     * inside the file, so a `.png` holding markup uploads clean. With it set, the
     * bytes are sniffed (`file-type`) and the detected type — not the browser's
     * `Content-Type`, and not the extension — has to appear below. `image/*` is
     * deliberately not used: the wildcard would re-admit types by name.
     *
     * `image/svg+xml` is listed because a logo is very often an SVG and a theme's
     * landing mark looks wrong as a PNG. It is the one type that carries script, and
     * `/api/media/file/*` is a Caddy carve-out serving uploads from the *customer's
     * own origin*, so an SVG is admitted only through `sanitizeSvgUpload`, which runs
     * first (`beforeOperation`). Its allowlist admits drawing elements and attributes
     * plus a narrow, bounded `filter` / `feGaussianBlur` / `feMerge` / `feMergeNode`
     * graph and CSS `@keyframes` animation for animated logos — nothing else, and
     * always refuse-don't-repair. The hook also returns a structured reason code so
     * the tenant uploader can explain a rejection. See the header of `src/lib/svg.ts`.
     * Payload then runs its own `validateSvg` over the result, and the file route
     * answers SVG with `script-src 'none'`. `tests/int/svg.int.spec.ts` and
     * `tests/int/uploads.int.spec.ts` pin the boundary: a scripted SVG, an SVG
     * wearing a `.png` name, a remote filter reference and SMIL are all refused,
     * while the checked-in animated Graphite fixture uploads.
     *
     * Files already stored are not re-validated and keep serving.
     */
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml'],
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
