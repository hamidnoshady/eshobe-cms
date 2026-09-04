// @vitest-environment node
//
// Not jsdom, which `vitest.config.mts` sets for every other int spec. jsdom runs
// the test in its own realm, so a `Buffer` created here is not the `Buffer` the
// upload pipeline's type detection recognises — a genuine PNG is then read as an
// unknown type and refused, which looks exactly like the allow-list being wrong.
// The uploads below are the one place in this suite that hands Payload raw bytes.
import type { Payload } from 'payload'

import type { Site } from '@/payload-types'

import sharp from 'sharp'
import { getPayload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'

/**
 * What a customer may put in their media library.
 *
 * `Media.upload.mimeTypes` is not a convenience filter on the admin file picker —
 * it is what switches on Payload's content-based check. With the key absent,
 * `checkFileRestrictions` screens filenames against a list of executable
 * extensions and never opens the file, so anything that is not a `.exe` uploads
 * clean whatever it actually contains. These assertions are here because that
 * distinction is invisible from the config alone.
 *
 * The case that matters is the *lying* upload: the payloads below declare
 * `image/png` and end in `.png`, and are rejected on their bytes.
 *
 * Run `pnpm seed` first — the fixture is the seeded `acme.localhost`.
 */
let payload: Payload
let siteId: string

const upload = (file: { data: Buffer; mimetype: string; name: string }) =>
  payload.create({
    collection: 'media',
    data: { alt: 'fixture', site: siteId },
    file: { ...file, size: file.data.length },
  })

beforeAll(async () => {
  payload = await getPayload({ config: await config })

  const { docs } = await payload.find({ collection: 'sites', depth: 0, pagination: false })
  const acme = (docs as Site[]).find((doc) => doc.domain === 'acme.localhost')
  if (!acme) throw new Error('seed first: acme.localhost is missing')
  siteId = String(acme.id)
}, 180_000)

describe('media uploads', () => {
  it('accepts a real raster image', async () => {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 110, b: 104 } },
    })
      .png()
      .toBuffer()

    const doc = await upload({ data: png, mimetype: 'image/png', name: 'logo.png' })

    expect(doc.mimeType).toBe('image/png')
  })

  it('refuses an SVG, the one image type that carries script', async () => {
    // `/api/media/file/*` is a Caddy carve-out serving uploads from the customer's
    // own origin, so an accepted SVG is stored XSS against that site.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'utf8',
    )

    await expect(upload({ data: svg, mimetype: 'image/svg+xml', name: 'logo.svg' })).rejects.toThrow()
  })

  it('refuses an SVG wearing a .png name and an image/png content-type', async () => {
    // The browser's Content-Type and the extension are both attacker-controlled.
    // Only the bytes are not, which is what the allow-list makes Payload read.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'utf8',
    )

    await expect(upload({ data: svg, mimetype: 'image/png', name: 'logo.png' })).rejects.toThrow()
  })

  it('refuses an HTML document wearing a .png name', async () => {
    const html = Buffer.from('<html><body><script>alert(1)</script></body></html>', 'utf8')

    await expect(upload({ data: html, mimetype: 'image/png', name: 'page.png' })).rejects.toThrow()
  })
})
