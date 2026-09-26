/**
 * Digit mapping between scripts — the primitive under `formatNumber` (render) and
 * `parsePrice` (input).
 */
/**
 * Digit substitution for strings that only look numeric — phone numbers, postal
 * codes, anything with a leading zero that `formatNumber` would eat.
 */
export declare const toLocaleDigits: (value: string, locale: string) => string;
/**
 * Persian-Indic and Arabic-Indic digits → ASCII, for anything typed *into* the
 * platform.
 */
export declare const toAsciiDigits: (value: string) => string;
//# sourceMappingURL=digits.d.ts.map