import type { CollectionConfig } from 'payload'

import { authenticated } from '../../access/authenticated'
import { authenticatedOrPublished } from '../../access/authenticatedOrPublished'
import { writeUnlessPublishing } from '../../access/publish'
import { allowedBlocks, siteBlocks } from '../../blocks'
import { hero } from '@/heros/config'
import { slugifyField } from '@/lib/slug'
import { slugField } from 'payload'
import { populatePublishedAt } from '../../hooks/populatePublishedAt'
import { uniqueSlugPerSite } from '../../hooks/uniqueSlugPerSite'
import { generatePreviewPath } from '../../utilities/generatePreviewPath'
import { revalidateDelete, revalidatePage } from './hooks/revalidatePage'

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
    read: authenticatedOrPublished,
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
      url: ({ data, req }) =>
        generatePreviewPath({ collection: 'pages', data, req, slug: data?.slug }),
    },
    preview: (data, { req }) =>
      generatePreviewPath({ collection: 'pages', data, req, slug: data?.slug as string }),
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
          label: 'Hero',
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
          label: 'Content',
        },
        {
          name: 'meta',
          label: 'SEO',
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
      admin: {
        position: 'sidebar',
      },
    },
    // `disableUnique` because a slug is only unique per `{ site, locale }` — see
    // `uniqueSlugPerSite`, which does the enforcing a DB index cannot.
    slugField({ disableUnique: true, localized: true, slugify: slugifyField }),
  ],
  hooks: {
    afterChange: [revalidatePage],
    beforeChange: [populatePublishedAt],
    beforeValidate: [uniqueSlugPerSite],
    afterDelete: [revalidateDelete],
  },
  versions: {
    drafts: {
      autosave: {
        interval: 100, // We set this interval for optimal live preview
      },
      schedulePublish: true,
    },
    maxPerDoc: 50,
  },
}
