import type { CurrencyCode } from '@/lib/money'

import type { GatewayDescriptor, GatewayId } from './types'

/**
 * What the platform knows about each Iranian PSP, in two tables that cannot drift.
 *
 * - `credentialFieldCatalogue` is **presentation**: one entry per credential key, with
 *   its Persian label, help text, widget kind and which gateways it is shown for.
 * - `gatewayDescriptors` is **behaviour**: base URLs, host allowlist, supported
 *   currencies, and which of those keys are mandatory to move money.
 *
 * Split rather than nested, because a key can be shared: `username` belongs to Digipay,
 * Snapp!Pay and Torob Pay. Nesting the label inside each provider would produce three
 * copies of one column's wording and one field in the admin named after whichever
 * provider sorted first. This is the same argument `src/blocks/index.ts` makes for its
 * registry table — a table that does not compile beats a derivation that quietly picks
 * the wrong copy.
 *
 * ## Where each contract came from
 *
 * - **ZarinPal** — the public v4 REST docs (`zarinpal.com/docs/paymentGateway/connectToGateway`):
 *   `POST /pg/v4/payment/request.json`, redirect to `zarinpal.com/pg/StartPay/{authority}`,
 *   `POST /pg/v4/payment/verify.json`. `merchant_id` is the whole credential.
 * - **Digipay** — the public UPG merchant docs (`mydigipay.com/developers/docs/upg`):
 *   `POST /oauth/token` (HTTP Basic over `client_id:client_secret`, `grant_type=password`),
 *   `POST /tickets/business?type=11` with `Agent` + `Digipay-Version` headers,
 *   `POST /purchases/verify?type={ticketType}`. Amounts are Rial.
 * - **Snapp!Pay** — the merchant API on `*.snapppay.ir` as published in the provider's own
 *   integration packages: `POST /api/online/v1/oauth/token` (Basic + `scope=online-merchant`),
 *   `GET /api/online/offer/v1/eligible`, `POST /api/online/payment/v1/token`, then
 *   `verify` → `settle`, with `revert`/`cancel`. Amounts are Rial. Snapp!Pay hands each
 *   merchant a base URL and a hosted-page address with their technical PDF, so both are
 *   per-row settings with the published defaults rather than hardcoded constants.
 * - **Torob Pay (ترب‌پی)** — no public documentation exists; approved merchants receive a
 *   gateway address and credentials from Torob support. So this descriptor describes the
 *   shape every Iranian instalment gateway has (create → redirect → verify → cancel) and
 *   makes the base URL and the three endpoint paths per-row settings. When Torob's
 *   technical document arrives, its paths go into the row and nothing here changes.
 *   `docs/payment-gateways.md` §"Torob Pay" records exactly that, and the admin copy
 *   below says it to whoever is filling the form in.
 */

/** Iranian PSPs settle in Rial or Toman; `USD`/`EUR` sites cannot use them at all. */
const IRR_IRT: CurrencyCode[] = ['IRT', 'IRR']

export type CredentialField = {
  /** Which gateways show this field (`admin.condition`). */
  gateways: GatewayId[]
  help?: string
  key: string
  /**
   * `secret` is AES-256-GCM'd before it reaches Postgres and its field is unreadable
   * through every API (`src/collections/PaymentGateways.ts`). `url` and `text` settings
   * are stored as typed but are *still* platform-admin-only: a base URL decides where
   * the money goes, which makes it as much a credential as a password is — and a
   * tenant-settable one would be an SSRF vector into the platform's own network.
   */
  kind: 'secret' | 'select' | 'text' | 'url'
  label: string
  options?: { label: string; value: string }[]
  placeholder?: string
}

export const credentialFieldCatalogue: CredentialField[] = [
  {
    gateways: ['zarinpal'],
    help: 'کد ۳۶ کاراکتری پذیرنده از پنل زرین‌پال. همین یک فیلد، کل اعتبارنامهٔ این درگاه است.',
    key: 'merchantId',
    kind: 'secret',
    label: 'شناسهٔ پذیرنده (merchant_id)',
    placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  },
  {
    gateways: ['zarinpal'],
    help: 'کد معرف، اگر در قرارداد با زرین‌پال دارید. خالی بگذارید مگر اینکه بدانید چیست.',
    key: 'referrerId',
    kind: 'text',
    label: 'کد معرف (referrer_id)',
  },
  {
    gateways: ['digipay', 'snappPay', 'torobPay'],
    help: 'نام کاربری پذیرنده، همان که ارائه‌دهندهٔ درگاه به شما داده است.',
    key: 'username',
    kind: 'secret',
    label: 'نام کاربری پذیرنده',
  },
  {
    gateways: ['digipay', 'snappPay', 'torobPay'],
    help: 'رمز عبور پذیرنده. رمزنگاری‌شده ذخیره می‌شود و هیچ API آن را برنمی‌گرداند.',
    key: 'password',
    kind: 'secret',
    label: 'رمز عبور پذیرنده',
  },
  {
    gateways: ['digipay', 'snappPay'],
    help: 'با رمز کلید به شکل base64(client_id:client_secret) در هدر Authorization فرستاده می‌شود.',
    key: 'clientId',
    kind: 'secret',
    label: 'شناسهٔ کلاینت (client_id)',
  },
  {
    gateways: ['digipay', 'snappPay'],
    key: 'clientSecret',
    kind: 'secret',
    label: 'رمز کلاینت (client_secret)',
  },
  {
    gateways: ['torobPay'],
    help: 'توکن درگاه از پنل ترب. اگر ترب فقط توکن داده است، نام کاربری و رمز عبور را خالی بگذارید.',
    key: 'token',
    kind: 'secret',
    label: 'توکن درگاه',
  },
  {
    gateways: ['digipay', 'snappPay', 'torobPay'],
    help: 'نشانی پایهٔ API درگاه. خالی یعنی نشانی رسمیِ همان محیط. این فیلد تصمیم می‌گیرد پول به کجا می‌رود؛ دامنهٔ آن هم باید در فهرست مجاز همان درگاه باشد.',
    key: 'baseUrl',
    kind: 'url',
    label: 'نشانی پایهٔ API',
  },
  {
    gateways: ['digipay'],
    help: '۰ = کیف پول، ۲ = درگاه بانکی (IPG). «بدون ترجیح» یعنی صفحهٔ انتخاب ابزار پرداختِ خودِ دیجی‌پی نمایش داده شود.',
    key: 'preferredGateway',
    kind: 'select',
    label: 'ابزار پرداخت ترجیحی',
    // `'none'` rather than `''`: an enum whose "unset" member is the empty string cannot
    // be told apart from a blank written by a seed or an import, and every reader would
    // have to re-derive which of the two it means.
    options: [
      { label: 'بدون ترجیح', value: 'none' },
      { label: 'کیف پول (۰)', value: '0' },
      { label: 'درگاه بانکی IPG (۲)', value: '2' },
    ],
  },
  {
    gateways: ['digipay'],
    help: 'نوع تیکتی که در `?type=` فرستاده می‌شود. ۱۱ همهٔ فیچرهای UPG را پوشش می‌دهد و پیش‌فرض مستندات است.',
    key: 'ticketType',
    kind: 'select',
    label: 'نوع تیکت',
    options: [
      { label: '۱۱ — یکپارچه (UPG)', value: '11' },
      { label: '۵ — اعتباری (Credit)', value: '5' },
      { label: '۱۳ — اقساطی (BNPL)', value: '13' },
    ],
  },
  {
    gateways: ['digipay'],
    help:
      'جزئیات سبد خرید (`basketDetailsDto`) فقط برای خرید اعتباری و اقساطی اجباری است. این پنج فیلد را فقط زمانی پر کنید که دیجی‌پی از شما خواسته باشد؛ «دستهٔ کالا» که خالی بماند، سبد ارسال نمی‌شود و مسیر IPG/کیف پول طی می‌شود.',
    key: 'basketCategoryId',
    kind: 'select',
    label: 'دستهٔ کالا (سبد خرید)',
    options: [
      { label: '— بدون سبد (IPG یا کیف پول)', value: 'none' },
      { label: 'موبایل', value: 'Mobile' },
      { label: 'لپ‌تاپ', value: 'laptop' },
      { label: 'تبلت', value: 'tablet' },
      { label: 'کنسول بازی', value: 'gameconsole' },
    ],
  },
  {
    gateways: ['digipay'],
    help: '۱ بادوام، ۲ مصرفی، ۳ سرویس/خدمات، ۴ مصرفیِ بادوام.',
    key: 'basketProductType',
    kind: 'select',
    label: 'نوع کالا (سبد خرید)',
    options: [
      { label: '۱ — بادوام', value: '1' },
      { label: '۲ — مصرفی', value: '2' },
      { label: '۳ — سرویس', value: '3' },
      { label: '۴ — مصرفیِ بادوام', value: '4' },
    ],
  },
  {
    gateways: ['digipay'],
    help: 'شناسهٔ فروشنده که دیجی‌پی به پذیرنده اختصاص می‌دهد.',
    key: 'sellerId',
    kind: 'text',
    label: 'شناسهٔ فروشنده (sellerId)',
  },
  {
    gateways: ['digipay'],
    help: 'شناسهٔ تأمین‌کننده که دیجی‌پی به پذیرنده اختصاص می‌دهد.',
    key: 'supplierId',
    kind: 'text',
    label: 'شناسهٔ تأمین‌کننده (supplierId)',
  },
  {
    gateways: ['digipay'],
    help: 'برند کالا در سبد خرید. خالی یعنی نام سایت.',
    key: 'basketBrand',
    kind: 'text',
    label: 'برند (سبد خرید)',
  },
  {
    gateways: ['snappPay'],
    help: 'الگوی نشانی صفحهٔ پرداخت اسنپ‌پی؛ `{token}` با توکن پرداخت جایگزین می‌شود. اگر پاسخ سرویس token خودش نشانی برگرداند، همان بر این الگو اولویت دارد.',
    key: 'payPageUrl',
    kind: 'text',
    label: 'الگوی نشانی صفحهٔ پرداخت',
    placeholder: 'https://pay.snapp.ir/merchant/pay/{token}',
  },
  {
    gateways: ['snappPay'],
    help: 'حداقل مبلغ مجاز اسنپ‌پی به ریال. خالی یعنی ۱٬۰۰۰٬۰۰۰ ریال (۱۰۰٬۰۰۰ تومان).',
    key: 'minAmountRial',
    kind: 'text',
    label: 'حداقل مبلغ (ریال)',
  },
  {
    gateways: ['snappPay'],
    help:
      'نوع کمیسیون کالا (`commissionType`) در هر قلم سبد. مقداری که اسنپ‌پی در مستندات فنی پذیرندهٔ شما نوشته؛ خالی یعنی ۱.',
    key: 'commissionType',
    kind: 'text',
    label: 'نوع کمیسیون کالا',
    placeholder: '1',
  },
  {
    gateways: ['torobPay'],
    help: 'مسیر سرویس ساخت تراکنش، نسبی به نشانی پایه. ترب مستندات عمومی ندارد؛ مسیر را از همان چیزی بگیرید که پشتیبانی ترب به شما داده است.',
    key: 'createPath',
    kind: 'text',
    label: 'مسیر ساخت تراکنش',
    placeholder: '/v1/payments',
  },
  {
    gateways: ['torobPay'],
    help: 'مسیر سرویس تأیید/استعلام. این سرویس باید server-to-server باشد؛ نتیجهٔ بازگشت مرورگر به‌تنهایی پرداخت را تأیید نمی‌کند.',
    key: 'verifyPath',
    kind: 'text',
    label: 'مسیر تأیید تراکنش',
    placeholder: '/v1/payments/verify',
  },
  {
    gateways: ['torobPay'],
    help: 'مسیر سرویس لغو/عودت تراکنش (اختیاری).',
    key: 'cancelPath',
    kind: 'text',
    label: 'مسیر لغو تراکنش',
    placeholder: '/v1/payments/cancel',
  },
  {
    gateways: ['torobPay', 'zarinpal'],
    help: 'واحدی که درگاه مبلغ را در آن می‌گیرد. «همان واحد سایت» پیش‌فرض است و توصیه می‌شود: تبدیل تومان به ریال یک‌بار، در `src/lib/money.ts` انجام می‌شود.',
    key: 'amountUnit',
    kind: 'select',
    label: 'واحد مبلغ ارسالی',
    // `'site'` is not a `CurrencyCode`, so `currencySetting` falls through to the order's
    // own snapshotted unit — which is the whole point of offering it, and why the fallback
    // is the order and not a hardcoded unit.
    options: [
      { label: 'همان واحد سایت', value: 'site' },
      { label: 'ریال', value: 'IRR' },
      { label: 'تومان', value: 'IRT' },
    ],
  },
]

export const gatewayDescriptors: Record<GatewayId, GatewayDescriptor> = {
  digipay: {
    allowedHosts: ['mydigipay.com', 'mydigipay.info'],
    blurb:
      'درگاه یکپارچهٔ دیجی‌پی (UPG): کیف پول، درگاه بانکی، اعتبار خرید و اقساط BNPL در یک تیکت.',
    credentials: [
      { key: 'username', required: true },
      { key: 'password', required: true },
      { key: 'clientId', required: true },
      { key: 'clientSecret', required: true },
    ],
    currencies: IRR_IRT,
    docsUrl: 'https://www.mydigipay.com/developers/docs/upg/',
    endpoints: {
      live: { api: 'https://api.mydigipay.com/digipay/api' },
      sandbox: { api: 'https://uat.mydigipay.info/digipay/api' },
    },
    id: 'digipay',
    kind: 'bnpl',
    label: 'دیجی‌پی',
    labelEn: 'Digipay',
    requiresMobile: true,
    settings: [
      { key: 'baseUrl' },
      { key: 'preferredGateway' },
      { key: 'ticketType' },
      // The basket is required for Digipay's credit/BNPL tickets and forbidden-ish for the
      // IPG/Wallet path, so it is opt-in: `basketCategoryId` empty means "do not send one".
      { key: 'basketCategoryId' },
      { key: 'basketProductType' },
      { key: 'sellerId' },
      { key: 'supplierId' },
      { key: 'basketBrand' },
    ],
  },

  snappPay: {
    allowedHosts: ['snapppay.ir', 'snappfintech.ir', 'snapp.ir'],
    blurb: 'پرداخت اقساطی اسنپ‌پی: خریدار در چهار قسط می‌پردازد و فروشگاه مبلغ را نقد دریافت می‌کند.',
    credentials: [
      { key: 'username', required: true },
      { key: 'password', required: true },
      { key: 'clientId', required: true },
      { key: 'clientSecret', required: true },
    ],
    currencies: IRR_IRT,
    docsUrl: 'https://pay.snapp.ir/merchant-acquisition/',
    endpoints: {
      live: { api: 'https://api.snapppay.ir/', pay: 'https://pay.snapp.ir/merchant/pay/{token}' },
      sandbox: {
        api: 'https://api-staging.snapppay.ir/',
        pay: 'https://pay-staging.snapp.ir/merchant/pay/{token}',
      },
    },
    id: 'snappPay',
    kind: 'bnpl',
    label: 'اسنپ‌پی',
    labelEn: 'Snapp!Pay',
    requiresMobile: true,
    settings: [
      { key: 'baseUrl' },
      { key: 'payPageUrl' },
      { key: 'minAmountRial' },
      { key: 'commissionType' },
    ],
  },

  torobPay: {
    allowedHosts: ['torob.com', 'torobpay.com', 'torobpay.ir'],
    blurb:
      'درگاه اقساطی ترب‌پی: خریدار ۲۵٪ را می‌پردازد و باقی را در سه قسط؛ تسویهٔ فروشنده نقدی است. ' +
      'ترب مستندات عمومی ندارد — نشانی و مسیرها را از پنل پذیرندهٔ ترب وارد کنید.',
    credentials: [
      // Either a username/password pair or a bare token; Torob has issued both. The
      // adapter accepts whichever is present and refuses only when neither is.
      { key: 'username' },
      { key: 'password' },
      { key: 'token' },
    ],
    currencies: IRR_IRT,
    docsUrl: 'https://torob.com/',
    endpoints: {
      live: { api: 'https://pay.torob.com/api' },
      sandbox: { api: 'https://pay.torob.com/api' },
    },
    id: 'torobPay',
    kind: 'bnpl',
    label: 'ترب‌پی',
    labelEn: 'Torob Pay',
    requiresMobile: true,
    settings: [
      // Required, and the only gateway whose base URL is: there is no published default
      // to fall back to, so a row without one has nowhere to send the buyer.
      { key: 'baseUrl', required: true },
      { key: 'createPath' },
      { key: 'verifyPath' },
      { key: 'cancelPath' },
      { key: 'amountUnit' },
    ],
  },

  zarinpal: {
    allowedHosts: ['zarinpal.com'],
    blurb: 'درگاه بانکی زرین‌پال، نسخهٔ ۴ وب‌سرویس. تنها چیزی که لازم دارد merchant_id پذیرنده است.',
    credentials: [{ key: 'merchantId', required: true }],
    currencies: IRR_IRT,
    docsUrl: 'https://www.zarinpal.com/docs/paymentGateway/connectToGateway',
    endpoints: {
      live: {
        api: 'https://api.zarinpal.com/pg/v4/payment',
        pay: 'https://www.zarinpal.com/pg/StartPay/{token}',
      },
      sandbox: {
        api: 'https://sandbox.zarinpal.com/pg/v4/payment',
        pay: 'https://sandbox.zarinpal.com/pg/StartPay/{token}',
      },
    },
    id: 'zarinpal',
    kind: 'psp',
    label: 'زرین‌پال',
    labelEn: 'ZarinPal',
    /**
     * v4 treats `mobile` as optional metadata, but the PSP's SMS is the only payment
     * confirmation most Iranian storefronts ever send, and a buyer with no receipt calls
     * the shop. So the checkout form asks for it and the adapter passes it on.
     */
    requiresMobile: true,
    settings: [{ key: 'referrerId' }, { key: 'amountUnit' }],
  },
}

/** Every gateway the platform ships, in the order the admin lists them. */
export const gatewayIds = Object.keys(gatewayDescriptors) as GatewayId[]

export const isGatewayId = (value: unknown): value is GatewayId =>
  typeof value === 'string' && (gatewayIds as string[]).includes(value)

export const gatewayDescriptor = (id: GatewayId): GatewayDescriptor => gatewayDescriptors[id]

/** `select` options for the admin, Persian label first. */
export const gatewayOptions = gatewayIds.map((id) => ({
  label: `${gatewayDescriptors[id].label} — ${gatewayDescriptors[id].labelEn}`,
  value: id,
}))

/** The catalogue entry for one key. Every descriptor key must have one, or the form lies. */
export const credentialField = (key: string): CredentialField | undefined =>
  credentialFieldCatalogue.find((field) => field.key === key)

/** Every credential/settings key the collection declares a column for. */
export const allCredentialKeys = credentialFieldCatalogue.map(({ key }) => key)

/** The keys one gateway reads, credentials and settings together. */
export const keysForGateway = (id: GatewayId): string[] => {
  const descriptor = gatewayDescriptors[id]

  return [...descriptor.credentials, ...descriptor.settings].map(({ key }) => key)
}

/** Which of one gateway's keys are encrypted at rest. */
export const secretKeysForGateway = (id: GatewayId): string[] =>
  keysForGateway(id).filter((key) => credentialField(key)?.kind === 'secret')

/**
 * The labels of everything one gateway needs and this row does not have.
 *
 * A half-filled row is allowed to *exist* — a platform admin starts a configuration and
 * comes back to it — but it can never be used: `resolve.ts` refuses to hand an
 * incomplete row to an adapter, and the collection's own hook refuses to switch one on.
 * One definition of "complete", so those two cannot disagree.
 */
export const missingCredentials = (id: GatewayId, values: Record<string, string>): string[] => {
  const descriptor = gatewayDescriptors[id]

  return [
    ...descriptor.credentials.filter(({ key, required }) => required && !values[key]?.trim()),
    ...descriptor.settings.filter(({ key, required }) => required && !values[key]?.trim()),
  ].map(({ key }) => credentialField(key)?.label ?? key)
}
