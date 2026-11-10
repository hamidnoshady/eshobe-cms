import type { PayloadRequest } from 'payload'

/**
 * Run one Local API write whose site has already been derived by the server
 * (from a site key or the Host), never from the submitted body. The multi-tenant
 * plugin rejects assigning a tenant to an anonymous REST request; in this narrow
 * window the write is internal, while its collection access and relationship
 * checks still run. Discard ambient user sessions so they cannot widen or override
 * the credential/host-derived tenant. Always restore the request, including on
 * validation failures; never use this wrapper for a caller-selected site.
 */
export const withDerivedSiteWrite = async <T>(req: PayloadRequest, write: () => Promise<T>): Promise<T> => {
  const api = req.payloadAPI
  const user = req.user
  req.payloadAPI = 'local'
  req.user = null
  try {
    return await write()
  } finally {
    req.payloadAPI = api
    req.user = user
  }
}
