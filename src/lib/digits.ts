/**
 * Digit mapping between scripts — the primitive under `formatNumber` (render) and
 * `parsePrice` (input).
 *
 * Lives beside `src/lib/format.ts` rather than inside it so `src/lib/money.ts` can
 * use it without importing the formatter, which imports the currency registry, which
 * money owns. `format.ts` re-exports `toLocaleDigits`, so the platform rule stands:
 * numbers are rendered through `src/lib/format.ts`.
 */

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹'

/**
 * Digit substitution for strings that only look numeric — phone numbers, postal
 * codes, anything with a leading zero that `formatNumber` would eat.
 */
export const toLocaleDigits = (value: string, locale: string): string =>
  locale === 'fa' ? toAsciiDigits(value).replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)]!) : value

/**
 * Persian-Indic and Arabic-Indic digits → ASCII, for anything typed *into* the
 * platform.
 *
 * Both sets because a Persian keyboard produces ۰۱۲ and an Arabic one ٠١٢, and a
 * price copied out of a PDF or a chat window arrives in whichever the source used.
 * A field that only accepts ASCII digits silently rejects a number a customer typed
 * correctly, which reads as a broken form.
 */
export const toAsciiDigits = (value: string): string =>
  value
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
