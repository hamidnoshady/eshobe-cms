/**
 * The only place dates and numbers are formatted.
 *
 * Persian pages get Shamsi (Jalali) dates and Persian-Indic digits; every other
 * locale gets its own calendar and digits from the same call site. Nothing else
 * may call `Intl` directly, use `toLocaleDateString()`, or interpolate a raw
 * `Date` — see CLAUDE.md.
 */
import type { CurrencyCode } from './money.js';
export declare const formatDate: (date: Date | string | number | null | undefined, locale: string, options?: Intl.DateTimeFormatOptions) => string;
export declare const formatNumber: (value: number, locale: string, options?: Intl.NumberFormatOptions) => string;
/**
 * Digit substitution for strings that only look numeric — phone numbers, postal
 * codes, anything with a leading zero that `formatNumber` would eat.
 *
 * Re-exported from `src/lib/digits.ts` so money parsing can share the mapping without
 * importing this module; the rule that every rendered number goes through here stands.
 */
export { toLocaleDigits } from './digits.js';
/**
 * A price, in the site's currency, in the active locale's digits.
 *
 * `minor` is the stored integer — see `src/lib/money.ts` for why prices are minor
 * units of the *site's* currency and not of the product. The unit word is appended
 * from the currency registry, because a bare number on an Iranian storefront is
 * ambiguous by a factor of ten.
 *
 * Renders `۱٬۲۰۰٬۰۰۰ تومان` on `fa` and `1,200,000 Toman` on `en` for the same
 * stored value.
 */
export declare const formatPrice: (minor: null | number | undefined, code: CurrencyCode, locale: string, options?: {
    hideUnit?: boolean;
}) => string;
//# sourceMappingURL=format.d.ts.map