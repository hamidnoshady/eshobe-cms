import * as migration_20260826_215740_initial_schema from './20260826_215740_initial_schema';
import * as migration_20260827_113713_wave6_media_prefix from './20260827_113713_wave6_media_prefix';
import * as migration_20260827_143142_wave7_store from './20260827_143142_wave7_store';
import * as migration_20260831_180943_fix_media_prefix_drift from './20260831_180943_fix_media_prefix_drift';
import * as migration_20260831_181044_add_api_keys from './20260831_181044_add_api_keys';
import * as migration_20260905_003232_wave10_payment_gateways from './20260905_003232_wave10_payment_gateways';
import * as migration_20260905_120000_tenant_domain_aliases from './20260905_120000_tenant_domain_aliases';
import * as migration_20260905_130000_cdn_integration from './20260905_130000_cdn_integration';
import * as migration_20260905_150000_domain_reseller from './20260905_150000_domain_reseller';
import * as migration_20260907_000000_storage_connections from './20260907_000000_storage_connections';
import * as migration_20260912_100401_saas_control_plane from './20260912_100401_saas_control_plane';
import * as migration_20260922_170603_wave11_theme_deployments from './20260922_170603_wave11_theme_deployments';
import * as migration_20260925_215628_wave11_deploy_gaps from './20260925_215628_wave11_deploy_gaps';

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
  {
    up: migration_20260905_130000_cdn_integration.up,
    down: migration_20260905_130000_cdn_integration.down,
    name: '20260905_130000_cdn_integration',
  },
  {
    up: migration_20260905_150000_domain_reseller.up,
    down: migration_20260905_150000_domain_reseller.down,
    name: '20260905_150000_domain_reseller',
  },
  {
    up: migration_20260907_000000_storage_connections.up,
    down: migration_20260907_000000_storage_connections.down,
    name: '20260907_000000_storage_connections',
  },
  {
    up: migration_20260912_100401_saas_control_plane.up,
    down: migration_20260912_100401_saas_control_plane.down,
    name: '20260912_100401_saas_control_plane',
  },
  {
    up: migration_20260922_170603_wave11_theme_deployments.up,
    down: migration_20260922_170603_wave11_theme_deployments.down,
    name: '20260922_170603_wave11_theme_deployments',
  },
  {
    up: migration_20260925_215628_wave11_deploy_gaps.up,
    down: migration_20260925_215628_wave11_deploy_gaps.down,
    name: '20260925_215628_wave11_deploy_gaps'
  },
];
