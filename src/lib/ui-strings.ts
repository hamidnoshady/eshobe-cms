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
    author: 'Author',
    buyNow: 'Buy',
    datePublished: 'Date published',
    email: 'Email',
    hours: 'Hours',
    name: 'Full name',
    next: 'Next',
    noResults: 'Nothing found.',
    note: 'Note (optional)',
    of: 'of',
    previous: 'Previous',
    outOfStock: 'Sold out',
    phone: 'Phone',
    posts: 'posts',
    postsHeading: 'Posts',
    quantity: 'Quantity',
    search: 'Search',
    searchPosts: 'Search the posts',
    showing: 'Showing',
    submitting: 'Sending…',
    to: 'to',
    untitled: 'Untitled',
  },
  fa: {
    address: 'نشانی',
    author: 'نویسنده',
    buyNow: 'خرید',
    datePublished: 'تاریخ انتشار',
    email: 'رایانامه',
    hours: 'ساعات کاری',
    name: 'نام و نام خانوادگی',
    next: 'بعدی',
    noResults: 'چیزی پیدا نشد.',
    note: 'یادداشت (اختیاری)',
    of: 'از',
    previous: 'قبلی',
    outOfStock: 'ناموجود',
    phone: 'تلفن همراه',
    posts: 'نوشته',
    postsHeading: 'نوشته‌ها',
    quantity: 'تعداد',
    search: 'جست‌وجو',
    searchPosts: 'جست‌وجو در نوشته‌ها',
    showing: 'نمایش',
    submitting: 'در حال ثبت…',
    to: 'تا',
    untitled: 'بی‌عنوان',
  },
} as const

export type UiStringKey = keyof (typeof uiStrings)['fa']

/** `fa` is the base locale, so it is also the fallback — not `en`. */
export const uiString = (key: UiStringKey, locale: string): string =>
  uiStrings[locale as keyof typeof uiStrings]?.[key] ?? uiStrings.fa[key]
