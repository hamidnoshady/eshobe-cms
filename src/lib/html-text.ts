/**
 * Archived source HTML → plain text, for the safe fallback render.
 *
 * A migrated entry whose body only exists as preserved WordPress HTML
 * (`content-entries.preservedHtml`) is rendered by the first-party theme as
 * *text*, never as markup: source HTML can carry scripts, event handlers and
 * shortcode output, and this platform has no runtime HTML sanitizer by
 * design (the same refuse-don't-repair stance as `src/lib/svg.ts`). The
 * lossless original stays in the database for the HTML→Lexical converter and
 * for audit; what a visitor sees in the meantime is its readable text. That
 * limitation is stated in the migration matrix rather than papered over.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '…',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  rsquo: '’',
  zwnj: '‌',
}

export const decodeHtmlEntities = (text: string): string =>
  text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const codePoint = body.startsWith('#x') || body.startsWith('#X')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)

      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : whole
    }

    return NAMED_ENTITIES[body] ?? whole
  })

/** Strip markup to readable text with paragraph breaks preserved. */
export const htmlToPlainText = (html?: null | string): string => {
  if (!html) return ''

  const text = html
    // Whole elements whose *contents* are not prose.
    .replace(/<(script|style|noscript|iframe|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Block boundaries become paragraph breaks; list items become lines.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|blockquote|pre|table|ul|ol|figure|figcaption)>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')

  return decodeHtmlEntities(text)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Plain text → paragraphs, for rendering the fallback as `<p>` elements. */
export const plainTextToParagraphs = (text: string): string[] =>
  text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
