import * as migration_20260826_215740_initial_schema from './20260826_215740_initial_schema';
import * as migration_20260827_143142_wave7_store from './20260827_143142_wave7_store';

export const migrations = [
  {
    up: migration_20260826_215740_initial_schema.up,
    down: migration_20260826_215740_initial_schema.down,
    name: '20260826_215740_initial_schema',
  },
  {
    up: migration_20260827_143142_wave7_store.up,
    down: migration_20260827_143142_wave7_store.down,
    name: '20260827_143142_wave7_store'
  },
];
