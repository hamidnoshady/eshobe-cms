// @vitest-environment node
//
// An animated logo only animates when the original SVG document reaches an <img>.
// Generated sizes and Next's optimizer turn it into one static frame; these tests
// pin the preview URL choice and the renderer's SVG branch.
import { readFileSync } from 'node:fs'

import type { Props as MediaProps } from '@/components/Media/types'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nextImageState = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }))
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    nextImageState.calls.push(props)
    return null
  },
}))

import { ImageMedia } from '@/components/Media/ImageMedia'
import type { PreviewMedia } from '@/lib/mediaPreview'

import {
  adminThumbnailUrl,
  isSvgMedia,
  mediaPreviewUrl,
  originalMediaUrl,
} from '@/lib/mediaPreview'

const svgPreview: PreviewMedia = {
  mimeType: 'image/svg+xml',
  url: '/api/media/file/graphite.svg',
  sizes: { thumbnail: { url: '/api/media/file/graphite-300.png' } },
}

const pngPreview: PreviewMedia = {
  mimeType: 'image/png',
  url: '/api/media/file/logo.png',
  sizes: { thumbnail: { url: '/api/media/file/logo-300.png' } },
}

// The full doc shape ImageMedia expects, carrying the fields Payload returns.
const svgDoc = {
  ...svgPreview,
  id: 'm1',
  updatedAt: 'v1',
  width: 320,
  height: 120,
} as unknown as MediaProps['resource']

const pngDoc = {
  ...pngPreview,
  id: 'm2',
  updatedAt: 'v1',
  width: 320,
  height: 120,
} as unknown as MediaProps['resource']

describe('media preview URLs', () => {
  beforeEach(() => {
    nextImageState.calls.length = 0
  })

  it('uses the original SVG URL, never a rasterized size', () => {
    expect(isSvgMedia(svgPreview)).toBe(true)
    expect(mediaPreviewUrl(svgPreview)).toBe(svgPreview.url)
    expect(originalMediaUrl(svgPreview)).toBe(svgPreview.url)
    expect(mediaPreviewUrl(pngPreview)).toBe('/api/media/file/logo-300.png')
    expect(isSvgMedia({ mimeType: null, url: '/api/media/file/mark.svg?v=2' })).toBe(true)
  })

  it('renders an SVG as a plain animated <img> with the original URL', () => {
    const markup = renderToStaticMarkup(React.createElement(ImageMedia, { resource: svgDoc }))

    expect(markup).toContain('data-animated-svg="true"')
    expect(markup).toContain('/api/media/file/graphite.svg?v1')
    expect(markup).not.toContain('graphite-300.png')
    expect(nextImageState.calls).toHaveLength(0)
  })

  it('still optimizes raster images through NextImage', () => {
    const markup = renderToStaticMarkup(React.createElement(ImageMedia, { resource: pngDoc }))

    expect(markup).not.toContain('data-animated-svg')
    expect(nextImageState.calls).toHaveLength(1)
    expect(nextImageState.calls[0]?.src).toBe('/api/media/file/logo.png?v1')
  })

  it('points Payload admin thumbnails at the original SVG document', () => {
    const source = readFileSync(
      new URL('../../src/collections/Media.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain('adminThumbnail: ({ doc }) => adminThumbnailUrl')
    expect(adminThumbnailUrl(svgPreview)).toBe(svgPreview.url)
    expect(adminThumbnailUrl(pngPreview)).toBe('/api/media/file/logo-300.png')
  })

  it('publishes the original URL from the site descriptor', () => {
    // The public theme contract must not switch to an `imageSizes` variant.
    const source = readFileSync(
      new URL('../../src/endpoints/siteDescriptor.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain("url: typeof media.url === 'string' ? media.url : null")
    expect(source).not.toContain('sizes?.thumbnail')
  })

  it('keeps the tenant picker and branding field on the animated original', () => {
    const source = readFileSync(
      new URL('../../src/admin/fields/TenantMediaUploadField.tsx', import.meta.url),
      'utf8',
    )
    expect(source).toContain('mediaPreviewUrl(doc)')
    expect(source).toContain('<AnimatedSvgPreviews')
    expect(source).toContain('displayPreview={hasOnlySvgSelection ? false : field.displayPreview}')
  })

  it('keeps the SVG-serving CSP as defence in depth', () => {
    const source = readFileSync(
      new URL('../../src/storage/adapter.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain("script-src 'none'; frame-src 'none'; object-src 'none'")
  })
})
