import type { CollectionBeforeValidateHook } from 'payload'

import { ValidationError } from 'payload'

import { RESERVED_PAGE_SLUGS } from '@/lib/slug'

/**
 * `posts` and `search` are Next.js routes under `[domain]`, and a static segment
 * outranks the `[domain]/[[...path]]` catch-all that resolves CMS pages. So a page
 * saved with one of those slugs is not shadowed with a warning — it is unreachable,
 * and its nav link renders the blog instead. Nothing errors; the editor just finds a
 * page that cannot be opened.
 *
 * Refusing the slug is the only fix that does not require the routing table to know
 * about the CMS: a reserved-word list in `src/lib/slug.ts` is shared by both sides, so
 * the route and this check cannot drift apart.
 *
 * Not applied to posts: a post at `/posts/x` cannot collide with a route, and its own
 * slug uniqueness is `uniqueSlugPerSite`'s job.
 */
export const reservedPageSlug: CollectionBeforeValidateHook = async ({ data, originalDoc, req }) => {
  const slug = (data?.slug ?? originalDoc?.slug) as string | undefined

  if (!slug) return data

  if ((RESERVED_PAGE_SLUGS as readonly string[]).includes(slug)) {
    throw new ValidationError({
      collection: 'pages',
      errors: [
        {
          message: `«${slug}» نشانی بخش دیگری از سایت است و برای برگه آزاد نیست.`,
          path: 'slug',
        },
      ],
      req,
    })
  }

  return data
}
