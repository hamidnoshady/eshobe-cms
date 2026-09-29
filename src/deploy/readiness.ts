/**
 * "Is this site ready for its theme?" — one ordered checklist instead of a failure found
 * three screens later.
 *
 * Deploying a theme spans two owners. The operator picks a package, an image and a domain;
 * the customer picks the pages, categories and answers the theme expects. Each half can be
 * finished while the other is not, and the symptom — a theme that deploys green and renders
 * an empty home page, or `/en` answering 404 — shows up on the customer's domain, not
 * where somebody could have fixed it. This module turns everything that is known into a
 * list, in the order somebody should act on it, with the first open item called out.
 *
 * ## Advisory, never a gate
 *
 * Nothing here blocks a deploy. `createDeployment` and `runDeployment` keep their own
 * refusals (verified domain, published package, required variables). A check that says
 * "blocks production" is a recommendation to the operator, derived from the same facts,
 * so it can never disagree with a refusal by being stricter about something the deploy
 * path would have allowed.
 *
 * ## Pure on purpose
 *
 * `computeThemeReadiness` takes plain data and reads nothing, so every rule is tested
 * without a database. `loadThemeReadiness` (`readinessLoader.ts`) gathers the facts.
 */

export type ReadinessScope = 'preview' | 'production'

export type ReadinessCheck = {
  id: string
  /** `blocked` = something is missing; `warn` = works, but a visitor may notice. */
  status: 'blocked' | 'ok' | 'warn'
  /** Persian, addressed to whoever can act. */
  message: string
  /** Which lane this check gates. `null` for advice that gates nothing. */
  blocks: null | ReadinessScope
  /** Who can fix it, so the console can point at the right screen. */
  owner: 'customer' | 'operator'
  /** Where the fix happens — the admin screen of the document the check is about. */
  href?: string
}

export type ReadinessSlot = {
  key: string
  labelFa: null | string
  required: boolean
  type: string
}

/** What is known about the document a slot points at. `null` = nothing is bound. */
export type SlotState = null | {
  /** The bound document exists on this site. False when it was deleted or is another site's. */
  found: boolean
  /** Locales (of the site's served ones) in which the document has content. */
  presentLocales: string[]
  /** A page/post that exists but is still a draft. */
  unpublished: boolean
  /** The document's admin edit URL, so a check about it can link straight there. */
  editHref?: string
}

export type ReadinessVariable = {
  key: string
  labelFa: null | string
  required: boolean
  /** Whether a value (or, for a secret, a stored secret) exists. */
  set: boolean
}

export type ReadinessInput = {
  /** A theme package is assigned to (or deployed on) the site. */
  assigned: boolean
  packageName: null | string
  packagePublished: boolean
  siteTypeAllowed: boolean
  /** `registry_image` packages deploy a built image, so one must exist for the commit. */
  registry: { artifactReady: boolean; needed: boolean }
  slots: ReadinessSlot[]
  slotStates: Record<string, SlotState>
  siteLocales: string[]
  variables: ReadinessVariable[]
  domainVerified: boolean
}

export type ThemeReadiness = {
  checks: ReadinessCheck[]
  /** The first thing to do, or `null` when nothing is open. */
  nextStep: null | ReadinessCheck
  readyForPreview: boolean
  readyForProduction: boolean
}

/** Locale codes read as Persian words — «en» means nothing to a site owner. */
const LOCALE_NAMES: Record<string, string> = { en: 'انگلیسی', fa: 'فارسی' }
const localeNames = (codes: string[]): string => codes.map((code) => LOCALE_NAMES[code] ?? code).join('، ')

const slotLabel = (slot: ReadinessSlot): string => `«${slot.labelFa?.trim() || slot.key}»`

const ok = (id: string, message: string, owner: ReadinessCheck['owner']): ReadinessCheck => ({
  blocks: null,
  id,
  message,
  owner,
  status: 'ok',
})

export const computeThemeReadiness = (input: ReadinessInput): ThemeReadiness => {
  const checks: ReadinessCheck[] = []

  if (!input.assigned) {
    checks.push({
      blocks: 'preview',
      id: 'theme-assigned',
      message: 'هنوز پوسته‌ای به این سایت اختصاص داده نشده است.',
      owner: 'operator',
      status: 'blocked',
    })
    // Nothing below means anything without a package to read a manifest from.
    return finish(checks)
  }
  checks.push(ok('theme-assigned', `پوستهٔ «${input.packageName ?? ''}» اختصاص داده شده است.`, 'operator'))

  if (!input.packagePublished) {
    checks.push({
      blocks: 'preview',
      id: 'package-published',
      message: 'این پوسته هنوز منتشر نشده است؛ ابتدا همگام‌سازی و انتشار آن را کامل کنید.',
      owner: 'operator',
      status: 'blocked',
    })
  }
  if (!input.siteTypeAllowed) {
    checks.push({
      blocks: 'preview',
      id: 'site-type',
      message: 'نوع این سایت با نوع‌های پشتیبانی‌شدهٔ پوسته سازگار نیست.',
      owner: 'operator',
      status: 'blocked',
    })
  }

  if (input.registry.needed && !input.registry.artifactReady) {
    checks.push({
      blocks: 'preview',
      id: 'artifact-ready',
      message:
        'برای آخرین کامیت پوسته هنوز تصویر آماده‌ و تأییدشده‌ای ثبت نشده است؛ پس از پایان ساخت در CI دوباره بررسی کنید.',
      owner: 'operator',
      status: 'blocked',
    })
  } else if (input.registry.needed) {
    checks.push(ok('artifact-ready', 'تصویر ساخته‌شدهٔ پوسته آماده است.', 'operator'))
  }

  // Values the theme asked the customer for. A missing required one fails the deploy itself.
  const missingVariables = input.variables.filter((variable) => variable.required && !variable.set)
  for (const variable of missingVariables) {
    checks.push({
      blocks: 'preview',
      id: `variable:${variable.key}`,
      message: `مقدار «${variable.labelFa?.trim() || variable.key}» در «تنظیمات پوسته» پر نشده است.`,
      owner: 'customer',
      status: 'blocked',
    })
  }
  if (input.variables.some((variable) => variable.required) && !missingVariables.length) {
    checks.push(ok('variables', 'مقادیر ضروری تنظیمات پوسته پر شده‌اند.', 'customer'))
  }

  // Content the theme will render. Preview may proceed with holes — that is how somebody
  // sees them — but going live with a missing required page is what customers notice.
  for (const slot of input.slots) {
    const state = input.slotStates[slot.key] ?? null
    const label = slotLabel(slot)

    if (!state || !state.found) {
      if (slot.required) {
        checks.push({
          blocks: 'production',
          id: `slot:${slot.key}`,
          message: state
            ? `محتوای انتخاب‌شده برای ${label} دیگر وجود ندارد؛ آن را دوباره انتخاب کنید.`
            : `برای ${label} هنوز محتوایی انتخاب نشده است.`,
          owner: 'customer',
          status: 'blocked',
        })
      }
      continue
    }

    if (state.unpublished) {
      checks.push({
        blocks: slot.required ? 'production' : null,
        id: `slot-draft:${slot.key}`,
        message: `محتوای انتخاب‌شده برای ${label} هنوز منتشر نشده و بازدیدکننده آن را نمی‌بیند.`,
        owner: 'customer',
        ...(state.editHref ? { href: state.editHref } : {}),
        status: slot.required ? 'blocked' : 'warn',
      })
      continue
    }

    // `fallbackLocale: false` is how renderers read: an untranslated page is a 404 on that
    // locale's URL, not the default language's text.
    //
    // The fix is never in «تنظیمات پوسته» — the theme only points at the document. It is
    // the document's own translation (the admin's locale switcher, which the link opens
    // on the missing language), or dropping the language from the site if it is not
    // wanted. Saying where is the whole difference between a warning and a riddle.
    const missing = input.siteLocales.filter((locale) => !state.presentLocales.includes(locale))
    if (missing.length) {
      const names = localeNames(missing)
      checks.push({
        blocks: null,
        ...(state.editHref
          ? { href: `${state.editHref}?locale=${encodeURIComponent(missing[0])}` }
          : {}),
        id: `slot-locale:${slot.key}`,
        message: `${label} نسخهٔ ${names} ندارد و آن نسخهٔ سایت برایش خالی یا ۴۰۴ می‌ماند. آن را باز کنید، زبان ویرایشگر (بالای صفحه) را روی ${names} بگذارید، ترجمه کنید و منتشر کنید؛ اگر سایت به زبان ${names} نیاز ندارد، آن را از «زبان‌ها» در تنظیمات سایت حذف کنید.`,
        owner: 'customer',
        status: 'warn',
      })
    }
  }
  const requiredSlots = input.slots.filter((slot) => slot.required)
  if (
    requiredSlots.length &&
    requiredSlots.every((slot) => {
      const state = input.slotStates[slot.key]
      return state?.found && !state.unpublished
    })
  ) {
    checks.push(ok('slots', 'همهٔ محتواهای ضروری پوسته انتخاب و منتشر شده‌اند.', 'customer'))
  }

  if (!input.domainVerified) {
    checks.push({
      blocks: 'production',
      id: 'domain-verified',
      message: 'دامنهٔ اصلی سایت هنوز تأیید نشده است؛ انتشار روی دامنه پس از تأیید DNS ممکن است.',
      owner: 'operator',
      status: 'blocked',
    })
  } else {
    checks.push(ok('domain-verified', 'دامنهٔ اصلی تأیید شده است.', 'operator'))
  }

  return finish(checks)
}

const finish = (checks: ReadinessCheck[]): ThemeReadiness => {
  const open = (check: ReadinessCheck) => check.status !== 'ok'
  const gates = (scope: ReadinessScope) =>
    checks.some(
      (check) => check.status === 'blocked' && (check.blocks === scope || (scope === 'production' && check.blocks === 'preview')),
    )
  return {
    checks,
    nextStep:
      checks.find((check) => check.status === 'blocked') ?? checks.find(open) ?? null,
    readyForPreview: !gates('preview'),
    readyForProduction: !gates('production'),
  }
}
