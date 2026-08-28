/**
 * The words the *platform* renders, as opposed to the words an editor typed.
 *
 * Payload localizes field labels and content; it has nothing to say about a submit
 * button or a form placeholder, and those are the only strings in a block component
 * that need a translation at all. Persian first: `fa` is the base locale, so an
 * unknown locale falls back to it, never to English.
 *
 * `src/blocks/Contact/Component.tsx` carried the first four of these on its own, with
 * a note to move them here the moment a second block needed the same thing. Wave 7
 * is that moment.
 */

export const uiStrings = {
  en: {
    address: 'Address',
    buyNow: 'Buy',
    email: 'Email',
    hours: 'Hours',
    name: 'Full name',
    note: 'Note (optional)',
    outOfStock: 'Sold out',
    phone: 'Phone',
    quantity: 'Quantity',
    submitting: 'Sending…',
  },
  fa: {
    address: 'نشانی',
    buyNow: 'خرید',
    email: 'رایانامه',
    hours: 'ساعات کاری',
    name: 'نام و نام خانوادگی',
    note: 'یادداشت (اختیاری)',
    outOfStock: 'ناموجود',
    phone: 'تلفن همراه',
    quantity: 'تعداد',
    submitting: 'در حال ثبت…',
  },
} as const

export type UiStringKey = keyof (typeof uiStrings)['fa']

/** `fa` is the base locale, so it is also the fallback — not `en`. */
export const uiString = (key: UiStringKey, locale: string): string =>
  uiStrings[locale as keyof typeof uiStrings]?.[key] ?? uiStrings.fa[key]
