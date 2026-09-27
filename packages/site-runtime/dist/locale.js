/** Direction and URL helpers shared by built-in and external renderers. */
export const dirFor = (locale) => (locale === 'fa' ? 'rtl' : 'ltr');
/** Prefix an internal path when the active locale is not the site's default locale. */
export const localeHref = (path, locale, siteDefault) => path.startsWith('/') && locale !== siteDefault ? `/${locale}${path === '/' ? '' : path}` : path;
//# sourceMappingURL=locale.js.map