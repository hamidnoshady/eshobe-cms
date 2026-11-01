/**
 * SSRF guard for a WordPress source address (issue #166, Migration Center
 * step 1).
 *
 * The migration wizard will make this server fetch whatever URL a tenant
 * pastes. Unvalidated, that is a server-side request forgery primitive with
 * the platform's network position — cloud metadata, the Postgres/Coolify
 * neighbours, other tenants' preview hosts. So the rule is allow-by-shape:
 *
 * - **HTTPS only, port 443 only, no embedded credentials**, no query/fragment.
 * - The host must be a public FQDN: IP literals are checked against every
 *   private/loopback/link-local/reserved/documentation range (v4 and v6,
 *   including v4-mapped v6), `localhost` and internal suffixes are refused,
 *   and a single-label host never resolves publicly anyway.
 * - When the caller performs the connection preflight it passes a DNS
 *   `lookup`; **every** returned address must be public, or the name could
 *   still be aimed at the LAN. Residual rebinding/TOCTOU risk between this
 *   check and the fetch is documented in the migration matrix — the fetch
 *   layer must not follow redirects to a different host (WP REST page links
 *   stay on the source origin; the client builds URLs from the validated
 *   base itself and ignores absolute `next` URLs).
 */

export type SourceUrlResult =
  | { baseUrl: string; ok: true }
  | { code: string; message: string; ok: false }

const refuse = (code: string, message: string): SourceUrlResult => ({ code, message, ok: false })

const parseIpv4 = (value: string): number[] | null => {
  const parts = value.split('.')

  if (parts.length !== 4) return null

  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))

  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null
}

const isPrivateIpv4 = ([a, b]: number[]): boolean =>
  a === 0 || // "this network"
  a === 10 || // private
  a === 127 || // loopback
  (a === 100 && b! >= 64 && b! <= 127) || // CGNAT shared address space
  (a === 169 && b === 254) || // link-local
  (a === 172 && b! >= 16 && b! <= 31) || // private
  (a === 192 && b === 0) || // IETF protocol assignments + TEST-NET-1 (192.0.2)
  (a === 192 && b === 88) || // 6to4 relays (deprecated)
  (a === 192 && b === 168) || // private
  (a === 198 && (b === 18 || b === 19)) || // benchmarking
  (a === 198 && b === 51) || // TEST-NET-2
  (a === 203 && b === 0) || // TEST-NET-3
  a! >= 240 // reserved + broadcast

const isPrivateIpv6 = (raw: string): boolean => {
  const value = raw.toLowerCase()

  if (value === '::1' || value === '::') return true
  if (value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return true // fe80::/10 link-local
  if (value.startsWith('fc') || value.startsWith('fd')) return true // fc00::/7 unique-local
  if (value.startsWith('ff')) return true // multicast
  if (value.startsWith('2001:db8')) return true // documentation

  // v4-mapped / v4-compatible: check the embedded v4 tail.
  const mapped = value.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mapped) {
    const octets = parseIpv4(mapped[1]!)

    if (!octets || isPrivateIpv4(octets)) return true
  }

  return false
}

/** True for an IP literal that must never be a migration source. */
export const isPrivateIp = (value: string): boolean => {
  const bare = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  const v4 = parseIpv4(bare)

  if (v4) return isPrivateIpv4(v4)
  if (bare.includes(':')) return isPrivateIpv6(bare)

  return false
}

const isIpLiteral = (hostname: string): boolean =>
  parseIpv4(hostname) !== null || hostname.includes(':')

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.home.arpa', '.lan']

/**
 * Validate + normalize a source base URL. The path is kept (WordPress is
 * often installed in a subdirectory, which `url.origin` would discard);
 * everything else about the URL is canonicalized or refused.
 */
export const validateSourceBaseUrlSyntax = (input: unknown): SourceUrlResult => {
  if (typeof input !== 'string' || !input.trim()) {
    return refuse('EMPTY', 'نشانی سایت وردپرسی را وارد کنید.')
  }

  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return refuse('INVALID_URL', 'نشانی معتبر نیست.')
  }

  if (url.protocol !== 'https:') {
    return refuse('NOT_HTTPS', 'اتصال مهاجرت فقط با HTTPS برقرار می‌شود.')
  }
  if (url.username || url.password) {
    return refuse(
      'EMBEDDED_CREDENTIALS',
      'نام کاربری و گذرواژه را داخل نشانی ننویسید؛ در گام اتصال جداگانه دریافت می‌شوند.',
    )
  }
  if (url.port && url.port !== '443') {
    return refuse('NON_STANDARD_PORT', 'فقط درگاه استاندارد HTTPS (۴۴۳) پشتیبانی می‌شود.')
  }
  if (url.search || url.hash) {
    return refuse('QUERY_OR_FRAGMENT', 'نشانی پایه نباید پارامتر یا بخش # داشته باشد.')
  }

  const hostname = url.hostname.toLowerCase()

  if (
    hostname === 'localhost' ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    return refuse('INTERNAL_HOST', 'نشانی‌های داخلی و محلی قابل مهاجرت نیستند.')
  }
  if (isIpLiteral(hostname)) {
    if (isPrivateIp(hostname)) {
      return refuse('PRIVATE_IP', 'IP خصوصی یا حلقه‌باز قابل مهاجرت نیست.')
    }
    return refuse(
      'IP_LITERAL',
      'به‌جای IP، نام دامنه عمومی سایت وردپرسی را وارد کنید تا گواهی TLS و میزبان بررسی شوند.',
    )
  }
  if (!hostname.includes('.') || hostname.startsWith('.') || hostname.endsWith('.') === false && hostname.includes('..')) {
    return refuse('NOT_FQDN', 'نام میزبان باید یک دامنه کامل عمومی باشد.')
  }
  if (!/^[a-z0-9\u00a1-\uffff.-]+$/i.test(hostname)) {
    return refuse('BAD_HOST_CHARS', 'نام میزبان نویسه غیرمجاز دارد.')
  }

  const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, '')}`

  return { baseUrl, ok: true }
}

export type HostLookup = (hostname: string) => Promise<{ address: string }[]>

/**
 * Syntax + DNS: refuse when *any* resolved address is non-public. `lookup`
 * is injected (production passes `node:dns/promises` `lookup` with
 * `{ all: true }`); tests pass a stub, so this module stays free of a DNS
 * dependency and of accidental network in the unit suite.
 */
export const validateSourceBaseUrl = async (
  input: unknown,
  { lookup }: { lookup?: HostLookup } = {},
): Promise<SourceUrlResult> => {
  const syntax = validateSourceBaseUrlSyntax(input)

  if (!syntax.ok || !lookup) return syntax

  const hostname = new URL(syntax.baseUrl).hostname

  let addresses: { address: string }[]
  try {
    addresses = await lookup(hostname)
  } catch {
    return refuse('DNS_FAILURE', 'نام دامنه resolve نشد؛ نشانی را بررسی کنید.')
  }

  if (!addresses.length) return refuse('DNS_FAILURE', 'نام دامنه resolve نشد؛ نشانی را بررسی کنید.')
  if (addresses.some(({ address }) => isPrivateIp(address))) {
    return refuse('DNS_TO_PRIVATE', 'این دامنه به یک نشانی خصوصی اشاره می‌کند و قابل مهاجرت نیست.')
  }

  return syntax
}
