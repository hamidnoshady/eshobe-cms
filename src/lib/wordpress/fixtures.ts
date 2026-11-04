/**
 * Synthetic WordPress/WooCommerce payloads for tests (issue #166 P5).
 *
 * Shapes follow the live REST APIs (WP `wp/v2` registries and entries, Woo
 * `wc/v3` products/orders), trimmed to the fields the discovery/mapping/dry-
 * run code reads. Every factory returns a fresh object so a test can mutate
 * its copy. Persian content is deliberate: slugs, titles and taxonomy trees
 * in the source language are the common case on this platform, not an edge.
 */

export const wpTypesResponse = (): Record<string, unknown> => ({
  attachment: {
    has_archive: false,
    hierarchical: false,
    name: 'رسانه',
    rest_base: 'media',
    rest_namespace: 'wp/v2',
    slug: 'attachment',
    taxonomies: [],
  },
  page: {
    has_archive: false,
    hierarchical: true,
    name: 'برگه‌ها',
    rest_base: 'pages',
    rest_namespace: 'wp/v2',
    slug: 'page',
    taxonomies: [],
  },
  portfolio: {
    has_archive: 'نمونه‌کار',
    hierarchical: false,
    name: 'نمونه‌کارها',
    rest_base: 'portfolio',
    rest_namespace: 'wp/v2',
    slug: 'portfolio',
    taxonomies: ['genre', 'post_tag'],
  },
  post: {
    has_archive: false,
    hierarchical: false,
    name: 'نوشته‌ها',
    rest_base: 'posts',
    rest_namespace: 'wp/v2',
    slug: 'post',
    taxonomies: ['category', 'post_tag'],
  },
  product: {
    has_archive: true,
    hierarchical: false,
    name: 'محصولات',
    rest_base: 'product',
    rest_namespace: 'wp/v2',
    slug: 'product',
    taxonomies: ['product_cat', 'product_tag'],
  },
})

export const wpTaxonomiesResponse = (): Record<string, unknown> => ({
  category: {
    hierarchical: true,
    name: 'دسته‌ها',
    rest_base: 'categories',
    slug: 'category',
    types: ['post'],
  },
  genre: {
    hierarchical: true,
    name: 'سبک‌ها',
    rest_base: 'genre',
    slug: 'genre',
    types: ['portfolio'],
  },
  post_tag: {
    hierarchical: false,
    name: 'برچسب‌ها',
    rest_base: 'tags',
    slug: 'post_tag',
    types: ['post', 'portfolio'],
  },
  product_cat: {
    hierarchical: true,
    name: 'دسته‌های محصول',
    rest_base: 'product_cat',
    slug: 'product_cat',
    types: ['product'],
  },
})

export const wpGenreTerms = (): Record<string, unknown>[] => [
  { count: 3, id: 11, name: 'مسکونی', parent: 0, slug: 'مسکونی', taxonomy: 'genre' },
  { count: 2, id: 12, name: 'ویلایی', parent: 11, slug: 'ویلایی', taxonomy: 'genre' },
  { count: 1, id: 13, name: 'تجاری', parent: 0, slug: 'تجاری', taxonomy: 'genre' },
]

export const wpPortfolioEntry = (): Record<string, unknown> => ({
  acf: {
    client: 'شرکت آوا',
    gallery_ids: [501, 502],
    related_post: 41,
    related_products: [31, 99],
    specs: [
      { label: 'متراژ', value: '۱۸۰ متر' },
      { label: 'سال', value: '۱۴۰۲' },
    ],
    year: 1402,
  },
  author: 7,
  content: { protected: false, rendered: '<p>دربارهٔ پروژه</p>' },
  date: '2024-05-01T10:00:00',
  date_gmt: '2024-05-01T06:30:00',
  excerpt: { protected: false, rendered: '<p>خلاصه</p>\n' },
  featured_media: 501,
  genre: [12],
  id: 42,
  link: 'https://example.ir/نمونه‌کار/خانه-کنار-دریا/',
  menu_order: 3,
  meta: { _thumbnail_id: '501', unmapped_plugin_key: 'x' },
  modified: '2024-06-01T09:00:00',
  modified_gmt: '2024-06-01T05:30:00',
  parent: 0,
  slug: 'خانه-کنار-دریا',
  status: 'publish',
  tags: [21],
  title: { rendered: 'خانهٔ کنار دریا' },
  type: 'portfolio',
})

export const wpMenus = (): Record<string, unknown>[] => [
  {
    description: 'ناوبری اصلی',
    id: 301,
    locations: ['primary'],
    name: 'منوی اصلی',
    slug: 'main-menu',
  },
]

export const wpMenuItems = (): Record<string, unknown>[] => [
  {
    attr_title: '',
    classes: ['nav-link'],
    description: '',
    id: 401,
    menu_order: 1,
    menus: 301,
    object: 'page',
    object_id: 40,
    parent: 0,
    status: 'publish',
    target: '',
    title: { rendered: 'درباره ما' },
    type: 'post_type',
    type_label: 'Page',
    url: 'https://example.ir/about/',
  },
  {
    attr_title: '',
    classes: [],
    description: 'محصول نمونه',
    id: 402,
    menu_order: 2,
    menus: [301],
    object: 'product',
    object_id: 31,
    parent: 0,
    status: 'publish',
    target: '',
    title: { rendered: 'کتاب الف' },
    type: 'post_type',
    type_label: 'Product',
    url: 'https://example.ir/product/book-a/',
  },
  {
    attr_title: '',
    classes: [],
    description: '',
    id: 403,
    menu_order: 3,
    menus: 301,
    object: 'genre',
    object_id: 12,
    parent: 402,
    status: 'publish',
    target: '',
    title: { rendered: 'ویلایی' },
    type: 'taxonomy',
    type_label: 'سبک‌ها',
    url: 'https://example.ir/genre/villa/',
  },
  {
    attr_title: '',
    classes: [],
    description: '',
    id: 404,
    menu_order: 4,
    menus: 301,
    object: 'custom',
    object_id: 404,
    parent: 0,
    status: 'publish',
    target: '_blank',
    title: { rendered: 'راهنما' },
    type: 'custom',
    type_label: 'Custom Link',
    url: 'https://example.org/help',
  },
]

export const wpComments = (): Record<string, unknown>[] => [
  {
    author: 15,
    author_email: 'buyer@example.ir',
    author_name: 'سارا مشتری',
    author_url: '',
    content: { rendered: '<p>نوشتهٔ بسیار خوبی بود.</p>' },
    date: '2024-02-04T10:00:00',
    date_gmt: '2024-02-04T06:30:00',
    id: 601,
    link: 'https://example.ir/hello-world/#comment-601',
    parent: 0,
    post: 41,
    status: 'approved',
    type: 'comment',
  },
  {
    author: 0,
    author_email: 'guest@example.ir',
    author_name: 'مهمان',
    author_url: 'https://example.org/guest',
    content: { rendered: '<p>پاسخ در انتظار بررسی است.</p>' },
    date: '2024-02-04T11:00:00',
    date_gmt: '2024-02-04T07:30:00',
    id: 602,
    link: 'https://example.ir/hello-world/#comment-602',
    parent: 601,
    post: 41,
    status: 'hold',
    type: 'comment',
  },
  {
    author: 15,
    author_email: 'buyer@example.ir',
    author_name: 'سارا مشتری',
    author_url: '',
    content: { rendered: '<p>کیفیت کتاب عالی بود.</p>' },
    date: '2024-02-05T10:00:00',
    date_gmt: '2024-02-05T06:30:00',
    id: 603,
    link: 'https://example.ir/product/book-a/#comment-603',
    // Core does not expose WooCommerce's unregistered `rating` comment meta;
    // the migration test serves it from `/wc/v3/products/reviews` instead.
    meta: [],
    parent: 0,
    post: 31,
    status: 'approved',
    type: 'review',
  },
  {
    author: 0,
    author_email: 'spam@example.net',
    author_name: 'هرزنامه',
    author_url: '',
    content: { rendered: '<p>پیام هرزنامه</p>' },
    date: '2024-02-06T10:00:00',
    date_gmt: '2024-02-06T06:30:00',
    id: 604,
    link: 'https://example.ir/نمونه‌کار/sea-house/#comment-604',
    parent: 0,
    post: 42,
    status: 'spam',
    type: 'comment',
  },
]

export const wooVariableProduct = (): Record<string, unknown> => ({
  attributes: [
    { id: 1, name: 'رنگ', options: ['قرمز', 'آبی'], variation: true, visible: true },
  ],
  date_created: '2024-01-01T00:00:00',
  id: 99,
  name: 'تیشرت نخی',
  permalink: 'https://example.ir/product/tshirt/',
  price: '',
  regular_price: '',
  sku: 'TS-01',
  slug: 'tshirt',
  status: 'publish',
  stock_quantity: null,
  type: 'variable',
  variations: [100, 101],
})

export const wooMultiLineOrder = (): Record<string, unknown> => ({
  currency: 'IRR',
  customer_id: 15,
  date_created: '2024-03-01T12:00:00',
  date_created_gmt: '2024-03-01T08:30:00',
  discount_total: '50000.00',
  fee_lines: [],
  id: 700,
  line_items: [
    { name: 'کتاب الف', product_id: 31, quantity: 2, subtotal: '400000.00', total: '360000.00' },
    { name: 'کتاب ب', product_id: 32, quantity: 1, subtotal: '250000.00', total: '240000.00' },
  ],
  number: '700',
  payment_method: 'zarinpal',
  shipping_total: '60000.00',
  status: 'completed',
  total: '660000.00',
  total_tax: '0.00',
  transaction_id: 'A0001',
})

/** Same order with a total that does not reconcile — the dry-run must flag it. */
export const wooOrderWithTotalMismatch = (): Record<string, unknown> => ({
  ...wooMultiLineOrder(),
  id: 701,
  number: '701',
  total: '999999.00',
})
