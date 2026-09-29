/**
 * Generated placeholder artwork for the demo seed.
 *
 * Why generated and not downloaded: the seed must run offline and produce the same
 * library every time, and a stock-photo URL is a dependency that rots. These are
 * abstract architectural compositions rendered from SVG by `sharp` (already a
 * dependency of Payload's upload pipeline) — no text, so no font is needed and
 * nothing here is Latin-only on a Persian page.
 *
 * ponytail: deterministic per `seed`, not "beautiful". Swap for real photography by
 * uploading over the same filenames.
 */
import sharp from 'sharp'

export type ArtKind = 'arch' | 'facade' | 'interior' | 'plan' | 'portrait' | 'product'

export type Palette = { bg: string; ink: string; accent: string; light: string; mid: string }

export const PALETTES = {
  sand: { accent: '#8c6f4a', bg: '#f1e9da', ink: '#1b1a18', light: '#fbf7ee', mid: '#cdbb9b' },
  slate: { accent: '#3f6e8c', bg: '#dfe6ea', ink: '#14202a', light: '#f3f6f8', mid: '#9db3c2' },
  clay: { accent: '#b5532f', bg: '#efd9cb', ink: '#2a1710', light: '#faeee6', mid: '#d6a68d' },
  olive: { accent: '#6b7a3a', bg: '#e6e8d4', ink: '#1c2210', light: '#f6f7ea', mid: '#b3bb8a' },
  night: { accent: '#d9a441', bg: '#1f2733', ink: '#0d1218', light: '#3a4657', mid: '#56657a' },
} satisfies Record<string, Palette>

export type PaletteName = keyof typeof PALETTES

const W = 1600
const H = 1067

/** mulberry32 — a 10-line seeded PRNG so the same key always draws the same picture. */
const rng = (seed: string) => {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = h >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const defs = (p: Palette) => `
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${p.light}"/><stop offset="1" stop-color="${p.bg}"/>
    </linearGradient>
    <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${p.ink}" stop-opacity=".0"/><stop offset="1" stop-color="${p.ink}" stop-opacity=".28"/>
    </linearGradient>
  </defs>`

const facade = (r: () => number, p: Palette) => {
  let body = `<rect width="${W}" height="${H}" fill="url(#sky)"/>
    <circle cx="${300 + r() * 1000}" cy="${140 + r() * 80}" r="${70 + r() * 40}" fill="${p.accent}" opacity=".35"/>`
  let x = -40
  while (x < W) {
    const w = 150 + r() * 200
    const h = 260 + r() * 520
    const y = H - 150 - h
    const tone = [p.ink, p.accent, p.mid, p.light][Math.floor(r() * 4)]
    body += `<rect x="${x}" y="${y}" width="${w}" height="${h + 150}" fill="${tone}"/>
      <rect x="${x + w * 0.62}" y="${y}" width="${w * 0.38}" height="${h + 150}" fill="url(#shade)"/>`
    const cols = Math.max(2, Math.floor(w / 46))
    const rows = Math.floor(h / 58)
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        if (r() > 0.28) {
          body += `<rect x="${x + 16 + i * ((w - 32) / cols)}" y="${y + 18 + j * 58}" width="${(w - 32) / cols - 10}" height="34" fill="${p.bg}" opacity="${0.35 + r() * 0.5}"/>`
        }
      }
    }
    x += w + 8 + r() * 24
  }
  body += `<rect y="${H - 150}" width="${W}" height="150" fill="${p.ink}" opacity=".9"/>
    <rect y="${H - 150}" width="${W}" height="6" fill="${p.accent}"/>`
  return body
}

const plan = (r: () => number, p: Palette) => {
  let body = `<rect width="${W}" height="${H}" fill="${p.light}"/>`
  for (let i = 0; i < W; i += 40) body += `<line x1="${i}" y1="0" x2="${i}" y2="${H}" stroke="${p.mid}" stroke-width=".5" opacity=".5"/>`
  for (let j = 0; j < H; j += 40) body += `<line x1="0" y1="${j}" x2="${W}" y2="${j}" stroke="${p.mid}" stroke-width=".5" opacity=".5"/>`
  const ox = 220 + r() * 60
  const oy = 140 + r() * 40
  body += `<rect x="${ox}" y="${oy}" width="1000" height="720" fill="none" stroke="${p.ink}" stroke-width="10"/>`
  const vx = ox + 320 + r() * 120
  const hy = oy + 260 + r() * 120
  body += `<line x1="${vx}" y1="${oy}" x2="${vx}" y2="${oy + 720}" stroke="${p.ink}" stroke-width="7"/>
    <line x1="${ox}" y1="${hy}" x2="${ox + 1000}" y2="${hy}" stroke="${p.ink}" stroke-width="7"/>
    <path d="M ${vx} ${hy - 110} A 110 110 0 0 1 ${vx + 110} ${hy}" fill="none" stroke="${p.accent}" stroke-width="4"/>
    <line x1="${vx}" y1="${hy - 110}" x2="${vx}" y2="${hy}" stroke="${p.accent}" stroke-width="4"/>
    <rect x="${ox + 60}" y="${oy + 60}" width="180" height="120" fill="${p.accent}" opacity=".25"/>
    <line x1="${ox}" y1="${oy + 780}" x2="${ox + 1000}" y2="${oy + 780}" stroke="${p.ink}" stroke-width="2"/>
    <line x1="${ox}" y1="${oy + 765}" x2="${ox}" y2="${oy + 795}" stroke="${p.ink}" stroke-width="2"/>
    <line x1="${ox + 1000}" y1="${oy + 765}" x2="${ox + 1000}" y2="${oy + 795}" stroke="${p.ink}" stroke-width="2"/>`
  return body
}

const arch = (r: () => number, p: Palette) => {
  let body = `<rect width="${W}" height="${H}" fill="url(#sky)"/>`
  const n = 4 + Math.floor(r() * 3)
  const w = W / n
  for (let i = 0; i < n; i++) {
    const x = i * w
    body += `<rect x="${x}" y="0" width="${w}" height="${H}" fill="${i % 2 ? p.mid : p.bg}"/>
      <path d="M ${x + 40} ${H} V ${380 + r() * 60} A ${(w - 80) / 2} ${(w - 80) / 2} 0 0 1 ${x + w - 40} ${380 + r() * 60} V ${H} Z" fill="${p.ink}" opacity="${0.55 + r() * 0.35}"/>
      <rect x="${x}" y="0" width="${w}" height="${H}" fill="url(#shade)"/>`
  }
  body += `<rect y="${H - 90}" width="${W}" height="90" fill="${p.accent}"/>`
  return body
}

const interior = (r: () => number, p: Palette) => {
  const wx = 300 + r() * 100
  const wy = 200
  return `<rect width="${W}" height="${H}" fill="${p.bg}"/>
    <polygon points="0,${H} ${wx},${H - 330} ${W - wx},${H - 330} ${W},${H}" fill="${p.mid}"/>
    <rect x="${wx}" y="${wy}" width="${W - 2 * wx}" height="${H - 330 - wy}" fill="${p.light}"/>
    <rect x="${wx + 120}" y="${wy + 70}" width="360" height="${H - 330 - wy - 160}" fill="${p.accent}" opacity=".35"/>
    <polygon points="${wx + 120},${H - 330} ${wx + 480},${H - 330} ${wx + 700},${H} ${wx - 60},${H}" fill="${p.light}" opacity=".55"/>
    <rect x="${W - wx - 380}" y="${H - 520}" width="260" height="190" fill="${p.ink}"/>
    <rect x="${W - wx - 400}" y="${H - 350}" width="300" height="30" fill="${p.accent}"/>
    <polygon points="0,0 ${wx},${wy} ${wx},${H - 330} 0,${H}" fill="${p.ink}" opacity=".12"/>`
}

const portrait = (r: () => number, p: Palette) => `
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  <circle cx="${W / 2}" cy="${H * 0.36}" r="${180 + r() * 30}" fill="${p.accent}"/>
  <path d="M ${W / 2 - 420} ${H} Q ${W / 2} ${H * 0.52} ${W / 2 + 420} ${H} Z" fill="${p.ink}"/>
  <circle cx="${W / 2 - 60}" cy="${H * 0.35}" r="12" fill="${p.ink}" opacity=".7"/>
  <circle cx="${W / 2 + 60}" cy="${H * 0.35}" r="12" fill="${p.ink}" opacity=".7"/>`

const product = (r: () => number, p: Palette) => {
  const cx = W / 2 + (r() - 0.5) * 120
  return `<rect width="${W}" height="${H}" fill="${p.bg}"/>
    <rect y="${H * 0.66}" width="${W}" height="${H * 0.34}" fill="${p.mid}"/>
    <ellipse cx="${cx}" cy="${H * 0.78}" rx="300" ry="34" fill="${p.ink}" opacity=".22"/>
    <rect x="${cx - 190}" y="${H * 0.30}" width="380" height="${H * 0.48}" rx="60" fill="${p.accent}"/>
    <rect x="${cx - 150}" y="${H * 0.22}" width="300" height="90" rx="26" fill="${p.ink}"/>
    <rect x="${cx - 130}" y="${H * 0.42}" width="260" height="190" rx="18" fill="${p.light}" opacity=".9"/>
    <rect x="${cx - 100}" y="${H * 0.47}" width="200" height="14" fill="${p.ink}" opacity=".7"/>
    <rect x="${cx - 100}" y="${H * 0.52}" width="140" height="14" fill="${p.ink}" opacity=".4"/>`
}

const drawers: Record<ArtKind, (r: () => number, p: Palette) => string> = {
  arch,
  facade,
  interior,
  plan,
  portrait,
  product,
}

/** A finished JPEG. `width` lets avatars and thumbnails stay small. */
export const renderArt = async (
  kind: ArtKind,
  seed: string,
  palette: PaletteName,
  size: { height?: number; width?: number } = {},
): Promise<Buffer> => {
  const p = PALETTES[palette]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${defs(p)}${drawers[kind](rng(seed), p)}</svg>`
  return sharp(Buffer.from(svg))
    .resize(size.width ?? W, size.height ?? undefined, { fit: 'cover' })
    .jpeg({ mozjpeg: true, quality: 82 })
    .toBuffer()
}

/**
 * A transparent PNG monogram: an arch inside a square, so the site has *a* logo and
 * favicon to show. No lettering — see the note at the top of this file.
 */
export const renderMark = async (seed: string, palette: PaletteName, size = 512): Promise<Buffer> => {
  const p = PALETTES[palette]
  const r = rng(seed)
  const inset = 70 + Math.floor(r() * 30)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <rect x="${inset}" y="${inset}" width="${512 - inset * 2}" height="${512 - inset * 2}" rx="28" fill="${p.ink}"/>
    <path d="M 176 400 V 250 A 80 80 0 0 1 336 250 V 400 Z" fill="${p.accent}"/>
    <rect x="176" y="392" width="160" height="8" fill="${p.light}"/>
  </svg>`
  return sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()
}
