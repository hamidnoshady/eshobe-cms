import * as migration_20260826_215740_initial_schema from './20260826_215740_initial_schema'
import * as migration_20260827_113713_wave6_media_prefix from './20260827_113713_wave6_media_prefix'
import * as migration_20260827_143142_wave7_store from './20260827_143142_wave7_store'
import * as migration_20260831_180943_fix_media_prefix_drift from './20260831_180943_fix_media_prefix_drift'
import * as migration_20260831_181044_add_api_keys from './20260831_181044_add_api_keys'
import * as migration_20260905_003232_wave10_payment_gateways from './20260905_003232_wave10_payment_gateways'
import * as migration_20260905_120000_tenant_domain_aliases from './20260905_120000_tenant_domain_aliases'

export const migrations = [
  {
    up: migration_20260826_215740_initial_schema.up,
    down: migration_20260826_215740_initial_schema.down,
    name: '20260826_215740_initial_schema',
  },
  {
    up: migration_20260827_113713_wave6_media_prefix.up,
    down: migration_20260827_113713_wave6_media_prefix.down,
    name: '20260827_113713_wave6_media_prefix',
  },
  {
    up: migration_20260827_143142_wave7_store.up,
    down: migration_20260827_143142_wave7_store.down,
    name: '20260827_143142_wave7_store',
  },
  {
    up: migration_20260831_180943_fix_media_prefix_drift.up,
    down: migration_20260831_180943_fix_media_prefix_drift.down,
    name: '20260831_180943_fix_media_prefix_drift',
  },
  {
    up: migration_20260831_181044_add_api_keys.up,
    down: migration_20260831_181044_add_api_keys.down,
    name: '20260831_181044_add_api_keys',
  },
  {
    up: migration_20260905_003232_wave10_payment_gateways.up,
    down: migration_20260905_003232_wave10_payment_gateways.down,
    name: '20260905_003232_wave10_payment_gateways',
  },
  {
    up: migration_20260905_120000_tenant_domain_aliases.up,
    down: migration_20260905_120000_tenant_domain_aliases.down,
    name: '20260905_120000_tenant_domain_aliases',
  },
]
