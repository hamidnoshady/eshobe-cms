import type { User } from '@/payload-types'

/** Staff session shape for int specs — not MCP API keys (`payload-mcp-api-keys`). */
export type CmsTypedUser = User & { collection: 'users' }

export const cmsTypedUser = (user: User): CmsTypedUser => ({
  ...user,
  collection: 'users',
})
