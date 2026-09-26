/** S3-compatible object-storage providers supported by the CMS connection model. */
export type StorageProviderId =
  | 'arvancloud'
  | 'aws'
  | 'cloudflare_r2'
  | 'minio'
  | 'wasabi'
  | 'digitalocean'
  | 'custom'

export type StorageProviderPreset = {
  defaultEndpoint?: string
  forcePathStyle: boolean
  id: StorageProviderId
  label: string
  region: string
}

export const STORAGE_PROVIDERS: Record<StorageProviderId, StorageProviderPreset> = {
  arvancloud: {
    defaultEndpoint: 'https://s3.ir-thr-at1.arvanstorage.ir',
    forcePathStyle: true,
    id: 'arvancloud',
    label: 'ArvanCloud',
    region: 'default',
  },
  aws: {
    forcePathStyle: false,
    id: 'aws',
    label: 'Amazon S3',
    region: 'eu-central-1',
  },
  cloudflare_r2: {
    forcePathStyle: true,
    id: 'cloudflare_r2',
    label: 'Cloudflare R2',
    region: 'auto',
  },
  custom: {
    forcePathStyle: true,
    id: 'custom',
    label: 'S3-compatible (سفارشی)',
    region: 'default',
  },
  digitalocean: {
    forcePathStyle: false,
    id: 'digitalocean',
    label: 'DigitalOcean Spaces',
    region: 'fra1',
  },
  minio: {
    forcePathStyle: true,
    id: 'minio',
    label: 'MinIO',
    region: 'default',
  },
  wasabi: {
    forcePathStyle: false,
    id: 'wasabi',
    label: 'Wasabi',
    region: 'eu-central-1',
  },
}

export const storageProviderOptions = (): { label: string; value: StorageProviderId }[] =>
  Object.values(STORAGE_PROVIDERS).map((preset) => ({ label: preset.label, value: preset.id }))

export const isStorageProviderId = (value: unknown): value is StorageProviderId =>
  typeof value === 'string' && value in STORAGE_PROVIDERS

export const applyProviderDefaults = (input: {
  endpoint?: string | null
  forcePathStyle?: boolean | null
  provider?: string | null
  region?: string | null
}): {
  endpoint: string
  forcePathStyle: boolean
  provider: StorageProviderId
  region: string
} => {
  const provider = isStorageProviderId(input.provider) ? input.provider : 'arvancloud'
  const preset = STORAGE_PROVIDERS[provider]
  return {
    endpoint: String(input.endpoint ?? preset.defaultEndpoint ?? '').trim(),
    forcePathStyle: input.forcePathStyle ?? preset.forcePathStyle,
    provider,
    region: String(input.region ?? preset.region).trim() || preset.region,
  }
}
