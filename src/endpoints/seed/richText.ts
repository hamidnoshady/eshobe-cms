import type { Page } from '@/payload-types'

type Block = { tag?: string; text: string; type: 'heading' | 'paragraph' }

/** The generated shape, so this drops straight into any `richText` field. */
type RichTextValue = NonNullable<Page['hero']['richText']>

/**
 * Minimal Lexical builder for seed content. Hand-writing the JSON for every
 * paragraph is unreadable, and a real editor is not available from a script.
 *
 * `direction` matters: Lexical stores it per node, and a Persian paragraph saved
 * as `ltr` renders with its punctuation on the wrong side.
 */
export const richText = (blocks: Block[], direction: 'ltr' | 'rtl' = 'rtl'): RichTextValue =>
  ({
    root: {
      type: 'root',
      children: blocks.map(({ tag = 'h2', text, type }) => ({
        type,
        ...(type === 'heading' ? { tag } : { textFormat: 0, textStyle: '' }),
        children: [
          { type: 'text', detail: 0, format: 0, mode: 'normal', style: '', text, version: 1 },
        ],
        direction,
        format: '',
        indent: 0,
        version: 1,
      })),
      direction,
      format: '',
      indent: 0,
      version: 1,
    },
  }) as RichTextValue
