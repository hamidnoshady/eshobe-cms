/**
 * Which URL a media preview should use.
 *
 * Payload can generate raster `imageSizes` for an uploaded image, and Next.js'
 * image optimizer can rasterize or refuse an SVG. Either one freezes a CSS-animated
 * logo at a single frame (or shows nothing at all). An SVG's own URL is the only
 * source that keeps its `@keyframes` running, in the admin picker, in a branding
 * field's preview and on the public site. Raster images keep using the small
 * generated thumbnail as before.
 */

export type PreviewMedia = {
  mimeType?: null | string
  sizes?: { thumbnail?: { url?: null | string } | null } | null
  url?: null | string
}

export const isSvgMedia = (media: PreviewMedia): boolean =>
  media.mimeType === 'image/svg+xml' || /\.svg(?:$|[?#])/i.test(media.url ?? '')

/** The original upload URL — never a generated size. */
export const originalMediaUrl = (media: PreviewMedia): string => media.url ?? ''

/** Thumbnail for a raster image; the animated original for an SVG. */
export const mediaPreviewUrl = (media: PreviewMedia): string =>
  isSvgMedia(media) ? originalMediaUrl(media) : media.sizes?.thumbnail?.url || originalMediaUrl(media)

/** Payload's `adminThumbnail` callback shape (`false | null | string`). */
export const adminThumbnailUrl = (media?: null | PreviewMedia): null | string =>
  media ? mediaPreviewUrl(media) || null : null
