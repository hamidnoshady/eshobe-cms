import type { CdnProvider, CdnZoneInput } from './types'

/**
 * Traefik DNS-01 certificate provisioning.
 *
 * The origin (Srv1) runs Traefik; the TLS certificate is issued by ACME using
 * the DNS-01 challenge against the zone's own DNS provider, so the certificate
 * is valid before the origin is exposed publicly. This module generates the
 * Traefik dynamic-config fragment that wires the ACME resolver and the
 * certificate to the zone's domains.
 *
 * The config is a plain object (Traefik accepts JSON dynamic config); the
 * deployment pipeline writes it to the Traefik dynamic directory. Nothing here
 * touches the network — it is pure config generation, testable without a live
 * Traefik or ACME server.
 */
export interface TraefikCertConfigInput {
  domains: string[]
  email: string
  storage: string
  dnsProvider: CdnProvider
  overrideDNS?: string[]
  resolverName?: string
}

export interface TraefikDynamicConfig {
  certificatesResolvers: {
    [resolver: string]: {
      acme: {
        email: string
        storage: string
        dnsChallenge: {
          provider: string
          overrideDNS?: string[]
        }
      }
    }
  }
  certificates: Array<{
    certResolver: string
    domains: string[]
  }>
}

/** The domains a certificate must cover: the zone apex plus every distinct
 * record name. ACME will issue a cert valid for all of them. */
export const zoneCertificateDomains = (zone: CdnZoneInput): string[] => {
  const names = new Set<string>([zone.zoneName])
  for (const record of zone.dnsRecords ?? []) {
    const name = record.name?.trim()
    if (!name || name === '@') continue // apex — already covered by zoneName
    const fqdn = name.includes('.') && name.endsWith(zone.zoneName)
      ? name
      : name.endsWith('.')
        ? `${name}${zone.zoneName}`
        : `${name}.${zone.zoneName}`
    names.add(fqdn)
  }
  return [...names].sort()
}

export const traefikDns01Config = (input: TraefikCertConfigInput): TraefikDynamicConfig => {
  const resolverName = input.resolverName ?? 'cms'
  return {
    certificatesResolvers: {
      [resolverName]: {
        acme: {
          email: input.email,
          storage: input.storage,
          dnsChallenge: {
            provider: input.dnsProvider,
            ...(input.overrideDNS && input.overrideDNS.length > 0
              ? { overrideDNS: input.overrideDNS }
              : {}),
          },
        },
      },
    },
    certificates: [
      {
        certResolver: resolverName,
        domains: input.domains,
      },
    ],
  }
}
