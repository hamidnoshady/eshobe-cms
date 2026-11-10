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
    addToCart: 'Add to cart',
    cart: 'Your cart',
    cartEmpty: 'Your cart is empty.',
    cartEstimate: 'Estimated total',
    cartPriceNotice: 'Prices and availability are confirmed at checkout.',
    categories: 'Menu categories',
    chooseFrom: 'Choose between',
    remove: 'Remove',
    requiredChoice: 'Required',
    optionalChoice: 'Optional',
    unavailable: 'Unavailable',
    uncategorized: 'Other items',
    invalidSelection: 'Choose the required options before adding this item.',
    checkoutFailed: 'Could not place the order. Please try again.',
    author: 'Author',
    buyNow: 'Buy',
    chooseOptions: 'Choose options',
    datePublished: 'Date published',
    email: 'Email',
    hours: 'Hours',
    instalments: 'Pay in instalments',
    mobileHint: 'This number must be the buyer’s own and registered with their wallet.',
    paymentMethod: 'Payment method',
    sandbox: 'Sandbox',
    name: 'Full name',
    next: 'Next',
    noImage: 'No image',
    noResults: 'Nothing found.',
    note: 'Note (optional)',
    of: 'of',
    previous: 'Previous',
    outOfStock: 'Sold out',
    phone: 'Phone',
    posts: 'posts',
    postsHeading: 'Posts',
    productHeading: 'Products',
    quantity: 'Quantity',
    search: 'Search',
    searchPosts: 'Search the posts',
    showing: 'Showing',
    sku: 'SKU',
    submit: 'Submit',
    submitting: 'Sending…',
    to: 'to',
    untitled: 'Untitled',
  },
  fa: {
    address: 'نشانی',
    addToCart: 'افزودن به سبد',
    cart: 'سبد شما',
    cartEmpty: 'سبد شما خالی است.',
    cartEstimate: 'جمع تقریبی',
    cartPriceNotice: 'قیمت و موجودی هنگام ثبت سفارش دوباره بررسی می‌شود.',
    categories: 'دسته‌های منو',
    chooseFrom: 'تعداد انتخاب',
    remove: 'حذف',
    requiredChoice: 'الزامی',
    optionalChoice: 'اختیاری',
    unavailable: 'غیرفعال',
    uncategorized: 'سایر موارد',
    invalidSelection: 'پیش از افزودن، گزینه‌های لازم را انتخاب کنید.',
    checkoutFailed: 'ثبت سفارش انجام نشد. لطفاً دوباره تلاش کنید.',
    author: 'نویسنده',
    buyNow: 'خرید',
    chooseOptions: 'انتخاب گزینه‌ها',
    datePublished: 'تاریخ انتشار',
    email: 'رایانامه',
    hours: 'ساعات کاری',
    instalments: 'پرداخت اقساطی',
    mobileHint: 'این شماره باید به نام خودِ خریدار و در کیف پول او ثبت شده باشد.',
    paymentMethod: 'روش پرداخت',
    sandbox: 'آزمایشی',
    name: 'نام و نام خانوادگی',
    next: 'بعدی',
    noImage: 'بدون تصویر',
    noResults: 'چیزی پیدا نشد.',
    note: 'یادداشت (اختیاری)',
    of: 'از',
    previous: 'قبلی',
    outOfStock: 'ناموجود',
    phone: 'تلفن همراه',
    posts: 'نوشته',
    postsHeading: 'نوشته‌ها',
    productHeading: 'محصولات',
    quantity: 'تعداد',
    search: 'جست‌وجو',
    searchPosts: 'جست‌وجو در نوشته‌ها',
    showing: 'نمایش',
    sku: 'کد کالا',
    submit: 'ثبت',
    submitting: 'در حال ثبت…',
    to: 'تا',
    untitled: 'بی‌عنوان',
  },
} as const

export type UiStringKey = keyof (typeof uiStrings)['fa']

/** `fa` is the base locale, so it is also the fallback — not `en`. */
export const uiString = (key: UiStringKey, locale: string): string =>
  uiStrings[locale as keyof typeof uiStrings]?.[key] ?? uiStrings.fa[key]
