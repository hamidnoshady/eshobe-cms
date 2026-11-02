import type { TextFieldSingleValidation } from 'payload'
import {
  BlockquoteFeature,
  BoldFeature,
  HeadingFeature,
  HorizontalRuleFeature,
  InlineCodeFeature,
  ItalicFeature,
  LinkFeature,
  OrderedListFeature,
  ParagraphFeature,
  StrikethroughFeature,
  SubscriptFeature,
  SuperscriptFeature,
  UnorderedListFeature,
  lexicalEditor,
  UnderlineFeature,
  type LinkFields,
} from '@payloadcms/richtext-lexical'

export const defaultLexical = lexicalEditor({
  features: [
    ParagraphFeature(),
    // The block/inline vocabulary a migrated WordPress body actually uses —
    // the Gutenberg converter (`src/lib/migration/gutenberg.ts`) emits
    // exactly these node kinds and nothing richer.
    HeadingFeature({ enabledHeadingSizes: ['h1', 'h2', 'h3', 'h4'] }),
    BlockquoteFeature(),
    OrderedListFeature(),
    UnorderedListFeature(),
    HorizontalRuleFeature(),
    UnderlineFeature(),
    BoldFeature(),
    ItalicFeature(),
    StrikethroughFeature(),
    InlineCodeFeature(),
    SubscriptFeature(),
    SuperscriptFeature(),
    LinkFeature({
      enabledCollections: ['pages', 'posts'],
      fields: ({ defaultFields }) => {
        const defaultFieldsWithoutUrl = defaultFields.filter((field) => {
          if ('name' in field && field.name === 'url') return false
          return true
        })

        return [
          ...defaultFieldsWithoutUrl,
          {
            name: 'url',
            type: 'text',
            admin: {
              condition: (_data, siblingData) => siblingData?.linkType !== 'internal',
            },
            label: ({ t }) => t('fields:enterURL'),
            required: true,
            validate: ((value, options) => {
              if ((options?.siblingData as LinkFields)?.linkType === 'internal') {
                return true // no validation needed, as no url should exist for internal links
              }
              return value ? true : 'URL is required'
            }) as TextFieldSingleValidation,
          },
        ]
      },
    }),
  ],
})
