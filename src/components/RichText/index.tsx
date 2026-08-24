import { MediaBlock } from '@/blocks/MediaBlock/Component'
import {
  DefaultNodeTypes,
  SerializedBlockNode,
  type DefaultTypedEditorState,
} from '@payloadcms/richtext-lexical'
import { JSXConvertersFunction, RichText as ConvertRichText } from '@payloadcms/richtext-lexical/react'

import { CodeBlock, CodeBlockProps } from '@/blocks/Code/Component'

import type {
  BannerBlock as BannerBlockProps,
  CallToActionBlock as CTABlockProps,
  MediaBlock as MediaBlockProps,
} from '@/payload-types'
import { BannerBlock } from '@/blocks/Banner/Component'
import { CallToActionBlock } from '@/blocks/CallToAction/Component'
import { CMSLink } from '@/components/Link'
import { cn } from '@/utilities/ui'

type NodeTypes =
  | DefaultNodeTypes
  | SerializedBlockNode<CTABlockProps | MediaBlockProps | BannerBlockProps | CodeBlockProps>

const jsxConverters: JSXConvertersFunction<NodeTypes> = ({ defaultConverters }) => ({
  ...defaultConverters,
  /**
   * Replaces the default link converter, which builds `<a href={'/' + slug}>` by
   * hand: that gives the home page a second URL (`/home`) and drops the locale
   * segment, so prose on `/en/about` links back into Persian. `CMSLink` is the one
   * place that knows both rules — this is a delegation, not a second copy.
   */
  link: ({ node, nodesToJSX }) => (
    <CMSLink
      newTab={node.fields.newTab}
      reference={node.fields.doc as React.ComponentProps<typeof CMSLink>['reference']}
      type={node.fields.linkType === 'internal' ? 'reference' : 'custom'}
      url={node.fields.url}
    >
      {nodesToJSX({ nodes: node.children })}
    </CMSLink>
  ),
  blocks: {
    banner: ({ node }) => <BannerBlock className="col-start-2 mb-4" {...node.fields} />,
    mediaBlock: ({ node }) => (
      <MediaBlock
        className="col-start-1 col-span-3"
        imgClassName="m-0"
        {...node.fields}
        captionClassName="mx-auto max-w-[48rem]"
        enableGutter={false}
        disableInnerContainer={true}
      />
    ),
    code: ({ node }) => <CodeBlock className="col-start-2" {...node.fields} />,
    cta: ({ node }) => <CallToActionBlock {...node.fields} />,
  },
})

type Props = {
  data: DefaultTypedEditorState
  enableGutter?: boolean
  enableProse?: boolean
} & React.HTMLAttributes<HTMLDivElement>

export default function RichText({ className, data, enableGutter = true, enableProse = true, ...rest }: Props) {
  return (
    /**
     * Our own wrapper, with `disableContainer` on the converter: `ConvertRichText`
     * destructures seven named props and silently drops the rest, so neither `dir`
     * nor anything in `React.HTMLAttributes` reaches the DOM when passed to it.
     *
     * `dir` is the field's own direction, not the page's. Lexical records `direction`
     * per node and the JSX converters discard it, so an English pull-quote inside a
     * Persian article — or a Persian field falling back on an `/en` page — would
     * inherit `rtl` from `<html>` and put its punctuation and list markers on the
     * wrong side. `@tailwindcss/typography` is fully logical (`padding-inline-start`),
     * so `dir` is all it takes to place them.
     */
    <div
      className={cn(
        'payload-richtext',
        {
          container: enableGutter,
          'max-w-none': !enableGutter,
          'mx-auto prose md:prose-md dark:prose-invert': enableProse,
        },
        className,
      )}
      dir={data?.root?.direction ?? undefined}
      {...rest}
    >
      <ConvertRichText converters={jsxConverters} data={data} disableContainer />
    </div>
  )
}
