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
import * as migration_20260926_120000_storage_health from './20260926_120000_storage_health';
import * as migration_20260926_120000_theme_github_webhook from './20260926_120000_theme_github_webhook';
import * as migration_20260926_180000_billing_execution_plane from './20260926_180000_billing_execution_plane';
import * as migration_20260926_190000_billing_meter_storage_key from './20260926_190000_billing_meter_storage_key';
import * as migration_20260926_200000_theme_runtime_contract from './20260926_200000_theme_runtime_contract';
import * as migration_20260927_120000_order_reversal_events from './20260927_120000_order_reversal_events';
import * as migration_20260927_160000_theme_bindings_lanes from './20260927_160000_theme_bindings_lanes';
import * as migration_20260927_170000_theme_bindings_schema_repair from './20260927_170000_theme_bindings_schema_repair';
import * as migration_20260927_210000_theme_artifact_architecture from './20260927_210000_theme_artifact_architecture';
import * as migration_20260928_000000_theme_design_defaults from './20260928_000000_theme_design_defaults';
import * as migration_20260928_120000_branding_home_logo from './20260928_120000_branding_home_logo';
import * as migration_20261001_120000_folders_site from './20261001_120000_folders_site';
import * as migration_20261002_163500_payload_mcp_plugin from './20261002_163500_payload_mcp_plugin';
import * as migration_20261004_120000_mcp_key_lifecycle from './20261004_120000_mcp_key_lifecycle';
import * as migration_20261004_130000_payload_390_columns from './20261004_130000_payload_390_columns';
import * as migration_20261005_120000_page_builder_media from './20261005_120000_page_builder_media';
import * as migration_20261005_180000_deploy_flow_fixes from './20261005_180000_deploy_flow_fixes';

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
    name: '20260925_215628_wave11_deploy_gaps',
  },
  {
    up: migration_20260926_120000_storage_health.up,
    down: migration_20260926_120000_storage_health.down,
    name: '20260926_120000_storage_health',
  },
  {
    up: migration_20260926_120000_theme_github_webhook.up,
    down: migration_20260926_120000_theme_github_webhook.down,
    name: '20260926_120000_theme_github_webhook',
  },
  {
    up: migration_20260926_180000_billing_execution_plane.up,
    down: migration_20260926_180000_billing_execution_plane.down,
    name: '20260926_180000_billing_execution_plane',
  },
  {
    up: migration_20260926_190000_billing_meter_storage_key.up,
    down: migration_20260926_190000_billing_meter_storage_key.down,
    name: '20260926_190000_billing_meter_storage_key',
  },
  {
    up: migration_20260926_200000_theme_runtime_contract.up,
    down: migration_20260926_200000_theme_runtime_contract.down,
    name: '20260926_200000_theme_runtime_contract',
  },
  {
    up: migration_20260927_120000_order_reversal_events.up,
    down: migration_20260927_120000_order_reversal_events.down,
    name: '20260927_120000_order_reversal_events',
  },
  {
    up: migration_20260927_160000_theme_bindings_lanes.up,
    down: migration_20260927_160000_theme_bindings_lanes.down,
    name: '20260927_160000_theme_bindings_lanes',
  },
  {
    up: migration_20260927_170000_theme_bindings_schema_repair.up,
    down: migration_20260927_170000_theme_bindings_schema_repair.down,
    name: '20260927_170000_theme_bindings_schema_repair',
  },
  {
    up: migration_20260927_210000_theme_artifact_architecture.up,
    down: migration_20260927_210000_theme_artifact_architecture.down,
    name: '20260927_210000_theme_artifact_architecture',
  },
  {
    up: migration_20260928_000000_theme_design_defaults.up,
    down: migration_20260928_000000_theme_design_defaults.down,
    name: '20260928_000000_theme_design_defaults',
  },
  {
    up: migration_20260928_120000_branding_home_logo.up,
    down: migration_20260928_120000_branding_home_logo.down,
    name: '20260928_120000_branding_home_logo',
  },
  {
    up: migration_20261001_120000_folders_site.up,
    down: migration_20261001_120000_folders_site.down,
    name: '20261001_120000_folders_site',
  },
  {
    up: migration_20261002_163500_payload_mcp_plugin.up,
    down: migration_20261002_163500_payload_mcp_plugin.down,
    name: '20261002_163500_payload_mcp_plugin'
  },
  {
    up: migration_20261004_120000_mcp_key_lifecycle.up,
    down: migration_20261004_120000_mcp_key_lifecycle.down,
    name: '20261004_120000_mcp_key_lifecycle'
  },
  {
    up: migration_20261004_130000_payload_390_columns.up,
    down: migration_20261004_130000_payload_390_columns.down,
    name: '20261004_130000_payload_390_columns'
  },
  {
    up: migration_20261005_120000_page_builder_media.up,
    down: migration_20261005_120000_page_builder_media.down,
    name: '20261005_120000_page_builder_media'
  },
  {
    up: migration_20261005_180000_deploy_flow_fixes.up,
    down: migration_20261005_180000_deploy_flow_fixes.down,
    name: '20261005_180000_deploy_flow_fixes'
  },
];
