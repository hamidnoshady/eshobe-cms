import type { CollectionConfig } from 'payload'

import {
  BlocksFeature,
  FixedToolbarFeature,
  HeadingFeature,
  HorizontalRuleFeature,
  InlineToolbarFeature,
  lexicalEditor,
} from '@payloadcms/richtext-lexical'

import { authenticated } from '../../access/authenticated'
import { authenticatedOrPublished } from '../../access/authenticatedOrPublished'
import { apiKeyAware } from '../../access/siteApiKey'
import { scopedPublishedRead } from '../../access/siteRead'
import { writeUnlessPublishing } from '../../access/publish'
import { Banner } from '../../blocks/Banner/config'
import { Code } from '../../blocks/Code/config'
import { MediaBlock } from '../../blocks/MediaBlock/config'
import { revalidateSiteDoc, revalidateSiteDocDelete } from '../../hooks/revalidateSiteDoc'
import { uniqueSlugPerSite } from '../../hooks/uniqueSlugPerSite'
import { generatePreviewPath } from '../../utilities/generatePreviewPath'
import { populateAuthors } from './hooks/populateAuthors'
import { POSTS_BASE } from '@/lib/slug'

import {
  MetaDescriptionField,
  MetaImageField,
  MetaTitleField,
  OverviewField,
  PreviewField,
} from '@payloadcms/plugin-seo/fields'
import { slugifyField } from '@/lib/slug'
import { slugField } from 'payload'

export const Posts: CollectionConfig<'posts'> = {
  slug: 'posts',
  access: {
    create: writeUnlessPublishing('posts'),
    delete: authenticated,
    // A site API key (WAVE-9 §9.4) sees its own site's drafts too.
    read: apiKeyAware(scopedPublishedRead(authenticatedOrPublished)),
    update: writeUnlessPublishing('posts'),
  },
  // This config controls what's populated by default when a post is referenced
  // https://payloadcms.com/docs/queries/select#defaultpopulate-collection-config-property
  // Type safe if the collection slug generic is passed to `CollectionConfig` - `CollectionConfig<'posts'>
  defaultPopulate: {
    title: true,
    slug: true,
    categories: true,
    meta: {
      image: true,
      description: true,
    },
  },
  admin: {
    defaultColumns: ['title', 'slug', 'updatedAt'],
    /**
     * Same contract as pages: the preview opens on the *site's* domain at the URL a
     * visitor would use (`/posts/hello`, `/en/posts/hello`), which is why `base` is
     * passed — without it a post previews over the page's `/hello`, which 404s.
     */
    livePreview: {
      url: ({ data, req }) => generatePreviewPath({ base: POSTS_BASE, data, req }),
    },
    preview: (data, { req }) => generatePreviewPath({ base: POSTS_BASE, data, req }),
    useAsTitle: 'title',
  },
  labels: {
    singular: 'نوشته',
    plural: 'نوشته‌ها',
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
          fields: [
            {
              name: 'heroImage',
              type: 'upload',
              relationTo: 'media',
            },
            {
              name: 'content',
              type: 'richText',
              editor: lexicalEditor({
                features: ({ rootFeatures }) => {
                  return [
                    ...rootFeatures,
                    HeadingFeature({ enabledHeadingSizes: ['h1', 'h2', 'h3', 'h4'] }),
                    BlocksFeature({ blocks: [Banner, Code, MediaBlock] }),
                    FixedToolbarFeature(),
                    InlineToolbarFeature(),
                    HorizontalRuleFeature(),
                  ]
                },
              }),
              label: false,
              required: true,
              localized: true,
            },
          ],
          label: 'محتوا',
        },
        {
          fields: [
            {
              name: 'relatedPosts',
              type: 'relationship',
              admin: {
                position: 'sidebar',
              },
              filterOptions: ({ id }) => {
                return {
                  id: {
                    not_in: [id],
                  },
                }
              },
              hasMany: true,
              relationTo: 'posts',
            },
            {
              name: 'categories',
              type: 'relationship',
              admin: {
                position: 'sidebar',
              },
              hasMany: true,
              relationTo: 'categories',
            },
          ],
          label: 'اطلاعات نوشته',
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
        date: {
          pickerAppearance: 'dayAndTime',
        },
        position: 'sidebar',
      },
      hooks: {
        beforeChange: [
          ({ siblingData, value }) => {
            if (siblingData._status === 'published' && !value) {
              return new Date()
            }
            return value
          },
        ],
      },
    },
    {
      name: 'authors',
      type: 'relationship',
      admin: {
        position: 'sidebar',
      },
      hasMany: true,
      relationTo: 'users',
    },
    // This field is only used to populate the user data via the `populateAuthors` hook
    // This is because the `user` collection has access control locked to protect user privacy
    // GraphQL will also not return mutated user data that differs from the underlying schema
    {
      name: 'populatedAuthors',
      type: 'array',
      access: {
        update: () => false,
      },
      admin: {
        disabled: true,
        readOnly: true,
      },
      fields: [
        {
          name: 'id',
          type: 'text',
        },
        {
          name: 'name',
          type: 'text',
        },
      ],
    },
    slugField({ disableUnique: true, localized: true, slugify: slugifyField }),
  ],
  hooks: {
    // `POSTS_BASE` is the whole difference between busting `/hello` (no such route
    // for a post) and busting `/posts/hello`.
    afterChange: [revalidateSiteDoc(POSTS_BASE)],
    afterDelete: [revalidateSiteDocDelete(POSTS_BASE)],
    afterRead: [populateAuthors],
    beforeValidate: [uniqueSlugPerSite],
  },
  versions: {
    drafts: {
      // Same interval as `pages` — see the note there on why not the template's 100ms.
      autosave: {
        interval: 375,
      },
      schedulePublish: true,
    },
    maxPerDoc: 50,
  },
}
