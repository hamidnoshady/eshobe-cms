/** Stable cache tag shared by site-scoped public readers and their write hooks. */
export const siteTag = (siteID: string, ...parts: string[]): string =>
  ['site', siteID, ...parts].join(':')

export const PUBLIC_SITE_DATA_REVALIDATE_SECONDS = 60
