import type { CurrencyCode } from '@/lib/money'

import { isCurrencyCode, rialToToman, tomanToRial } from '@/lib/money'

import type { CheckoutOrder } from '../types'
import { isIranianCurrency } from './types'

/**
 * The one place a gateway adapter is allowed to ask "what number do I send?".
 *
 * `CLAUDE.md`'s money rule is that `۱ تومان = ۱۰ ریال` appears exactly once, in
 * `src/lib/money.ts`. Every Iranian PSP in this directory wants one of those two units
 * and each wants a different one — ZarinPal v4 takes either and is told which, Digipay
 * and Snapp!Pay take Rial, Torob Pay takes whatever its panel says — so without this
 * module the factor of ten would appear once per adapter, and one of them would be the
 * one that is wrong by 10×.
 *
 * An order's `total` is already in the *site's* currency minor units (`orders` snapshots
 * both the number and the unit, so a site that later switches Rial→Toman does not rewrite
 * its history). Converting means reading that unit, never assuming it.
 */

export class UnsupportedCurrency extends Error {
  constructor(code: string) {
    super(
      `درگاه‌های ایرانی فقط تومان و ریال تسویه می‌کنند؛ واحد پول این سایت «${code}» است.`,
    )
    this.name = 'UnsupportedCurrency'
  }
}

export type GatewayAmount = {
  /** The integer to put in the request body. */
  amount: number
  /** The unit that integer is in — sent to the PSP when the PSP has a field for it. */
  unit: CurrencyCode
}

/**
 * The order's total, in `unit`.
 *
 * `unit` defaults to the site's own currency, which is the right answer for ZarinPal v4
 * (it takes `currency` alongside `amount`) and wrong for a provider that only speaks
 * Rial — hence the parameter. A tenant may also override it per row via the `amountUnit`
 * setting, for the merchant whose PSP account was opened in the other unit.
 */
export const amountIn = (order: CheckoutOrder, unit?: CurrencyCode | null): GatewayAmount => {
  if (!isIranianCurrency(order.currency)) throw new UnsupportedCurrency(order.currency)

  const target = (unit && isIranianCurrency(unit) ? unit : order.currency) as 'IRR' | 'IRT'

  if (target === order.currency) return { amount: order.total, unit: target }

  if (target === 'IRR') return { amount: tomanToRial(order.total), unit: target }

  try {
    return { amount: rialToToman(order.total), unit: target }
  } catch {
    // A Rial-denominated order whose total is not a whole Toman cannot be quoted to a
    // PSP that only speaks Toman. `rialToToman` throws rather than rounding, because
    // rounding silently is how a price stops matching the money — so this says so.
    throw new UnsupportedCurrency(`${order.currency}→${target}`)
  }
}

/**
 * Does a PSP's reported amount match this order?
 *
 * Every provider that returns an amount on verify or on the callback returns it in *its*
 * own unit, which is not necessarily the one we sent. Comparing the two numbers directly
 * is how a Rial/Toman mix-up turns into "verified" on a tenth of the money — so the
 * reported figure is normalised to Toman and compared against the order in Toman.
 *
 * `tolerance` exists because a PSP is allowed to be right about a different number than
 * the one we asked for: a discount applied at the gateway, or a rounding rule on its
 * side. It defaults to zero, and an adapter that needs a looser one says so out loud.
 */
export const amountMatches = (
  order: CheckoutOrder,
  reported: null | number | string | undefined,
  reportedUnit: CurrencyCode | null | undefined,
  tolerance = 0,
): boolean => {
  if (reported === null || reported === undefined || reported === '') return false

  const value = Number(reported)

  if (!Number.isFinite(value)) return false

  const inToman = (amount: number, unit: CurrencyCode | null | undefined): null | number => {
    if (!unit) return null
    if (!isIranianCurrency(unit)) return null

    if (unit === 'IRT') return amount

    try {
      return rialToToman(Math.round(amount))
    } catch {
      // `rialToToman` throws on a figure that is not a whole Toman: a PSP quoting
      // ۱۰۰۰۰۵ ریال is quoting something we cannot have asked for, and "does not match"
      // is the correct answer rather than an exception from inside a comparison.
      return null
    }
  }

  const reportedToman = inToman(value, reportedUnit)
  const expectedToman = inToman(order.total, order.currency)

  if (reportedToman === null || expectedToman === null) return false

  // `rialToToman` throws on a figure that is not a whole Toman — a PSP quoting ۱۰۰۰۰۵
  // ریال is quoting something we cannot have asked for, and "does not match" is the
  // correct answer rather than an exception from inside a comparison.
  return Math.abs(reportedToman - expectedToman) <= tolerance
}

/**
 * A row's `amountUnit` setting, as a `CurrencyCode` — or the fallback when it is anything
 * else.
 *
 * The setting arrives as a `string` because a credential row is a bag of strings, and
 * `amountIn` needs a unit it can convert with. A row carrying `amountUnit: 'tomann'` —
 * typed once, in a field with no enum, by a platform admin — must not become a `NaN` amount
 * sent to a PSP, and must not become the order's own unit by accident either: falling back
 * explicitly to what the adapter says is the difference between a refusal and a payment for
 * the wrong number.
 */
export const currencySetting = (value: unknown, fallback: CurrencyCode): CurrencyCode =>
  isCurrencyCode(value) ? value : fallback
