// @vitest-environment node
import { getPayload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'

beforeAll(async () => {
  await getPayload({ config: await config })
}, 180_000)

describe('theme runtime schema (migrated database)', () => {
  it('has site_branding and theme runtime columns', async () => {
    const payload = await getPayload({ config: await config })
    const pool = payload.db.pool

    const branding = await pool.query("SELECT to_regclass('public.site_branding') AS name")
    expect(branding.rows[0]?.name).toBe('site_branding')

    const runtimeCol = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'site_theme_settings' AND column_name = 'runtime_settings'
    `)
    expect(runtimeCol.rows.map((row: { column_name: string }) => row.column_name)).toContain(
      'runtime_settings',
    )
  })
})
