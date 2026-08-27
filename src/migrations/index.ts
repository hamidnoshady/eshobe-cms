import * as migration_20260826_215740_initial_schema from './20260826_215740_initial_schema'
import * as migration_20260827_113713_wave6_media_prefix from './20260827_113713_wave6_media_prefix'

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
]
