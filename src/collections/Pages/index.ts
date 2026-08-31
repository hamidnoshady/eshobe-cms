import type { CollectionConfig } from 'payload'

import { authenticated } from '../../access/authenticated'
import { authenticatedOrPublished } from '../../access/authenticatedOrPublished'
import { apiKeyAware } from '../../access/siteApiKey'
import { scopedPublishedRead } from '../../access/siteRead'
import { writeUnlessPublishing } from '../../access/publish'
import { allowedBlocks, siteBlocks } from '../../blocks'
import { hero } from '@/heros/config'
import { slugifyField } from '@/lib/slug'
import { slugField } from 'payload'
import { populatePublishedAt } from '../../hooks/populatePublishedAt'
import { uniqueSlugPerSite } from '../../hooks/uniqueSlugPerSite'
import { revalidateSiteDoc, revalidateSiteDocDelete } from '../../hooks/revalidateSiteDoc'
import { reservedPageSlug } from '../../hooks/reservedPageSlug'
import { generatePreviewPath } from '../../utilities/generatePreviewPath'

import {
  MetaDescriptionField,
  MetaImageField,
  MetaTitleField,
  OverviewField,
  PreviewField,
} from '@payloadcms/plugin-seo/fields'

export const Pages: CollectionConfig<'pages'> = {
  slug: 'pages',
  access: {
    create: writeUnlessPublishing('pages'),
    delete: authenticated,
    // Host-scoped as well as publish-gated: this collection is readable over the
    // public REST/GraphQL API by a second renderer (`src/access/siteRead.ts`).
    // A site API key (WAVE-9 §9.4) sees its own site's drafts too — it is that
    // site's own headless client, not an anonymous visitor.
    read: apiKeyAware(scopedPublishedRead(authenticatedOrPublished)),
    update: writeUnlessPublishing('pages'),
  },
  // This config controls what's populated by default when a page is referenced
  // https://payloadcms.com/docs/queries/select#defaultpopulate-collection-config-property
  // Type safe if the collection slug generic is passed to `CollectionConfig` - `CollectionConfig<'pages'>
  defaultPopulate: {
    title: true,
    slug: true,
  },
  admin: {
    defaultColumns: ['title', 'slug', 'updatedAt'],
    livePreview: {
      url: ({ data, req }) => generatePreviewPath({ data, req }),
    },
    preview: (data, { req }) => generatePreviewPath({ data, req }),
    useAsTitle: 'title',
  },
  labels: {
    singular: 'برگه',
    plural: 'برگه‌ها',
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      label: 'عنوان',
      required: true,
      localized: true,
    },
    {
      type: 'tabs',
      tabs: [
        {
          fields: [hero],
          label: 'بخش نخست',
        },
        {
          fields: [
            {
              name: 'layout',
              type: 'blocks',
              blocks: siteBlocks,
              // Not localized: a localized container gives every locale its own list
              // of blocks, so editors would rebuild the page per language. The text
              // fields *inside* each block carry `localized: true` instead.
              filterOptions: allowedBlocks,
              required: true,
              admin: {
                initCollapsed: true,
              },
            },
          ],
          label: 'محتوا',
        },
        {
          name: 'meta',
          label: 'سئو',
          fields: [
            OverviewField({
              titlePath: 'meta.title',
              descriptionPath: 'meta.description',
              imagePath: 'meta.image',
            }),
            MetaTitleField({
              hasGenerateFn: true,
              overrides: { localized: true },
            }),
            MetaImageField({
              relationTo: 'media',
            }),

            MetaDescriptionField({ overrides: { localized: true } }),
            PreviewField({
              // if the `generateUrl` function is configured
              hasGenerateFn: true,

              // field paths to match the target field for data
              titlePath: 'meta.title',
              descriptionPath: 'meta.description',
            }),
          ],
        },
      ],
    },
    {
      name: 'publishedAt',
      type: 'date',
      label: 'تاریخ انتشار',
      admin: {
        components: {
          // Payload's picker is Gregorian; this echoes the Shamsi equivalent under it.
          Description: '@/fields/ShamsiDateHint#ShamsiDateHint',
        },
        position: 'sidebar',
      },
    },
    // `disableUnique` because a slug is only unique per `{ site, locale }` — see
    // `uniqueSlugPerSite`, which does the enforcing a DB index cannot.
    slugField({ disableUnique: true, localized: true, slugify: slugifyField }),
  ],
  hooks: {
    afterChange: [revalidateSiteDoc()],
    beforeChange: [populatePublishedAt],
    beforeValidate: [uniqueSlugPerSite, reservedPageSlug],
    afterDelete: [revalidateSiteDocDelete()],
  },
  versions: {
    drafts: {
      autosave: {
        /**
         * Live preview is server-rendered here: the admin posts a bare
         * `payload-document-event` and the page re-fetches, so the pane only updates
         * as often as the document is *saved*. 375ms is the plan's figure — long
         * enough that a burst of typing is one write, short enough to read as live.
         * The template's 100ms writes a row and a version per keystroke-pause, which
         * on Postgres is four times the version churn for no visible gain.
         */
        interval: 375,
      },
      schedulePublish: true,
    },
    maxPerDoc: 50,
  },
}
