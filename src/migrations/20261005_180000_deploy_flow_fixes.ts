import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Deploy-flow fixes.
 *
 * - `site_deployments.platform_env_fingerprint`: a non-secret digest of the platform
 *   env a deploy wrote into the application (`platformEnvFingerprint` in
 *   `src/deploy/environment.ts`). A live row whose digest differs from what a deploy
 *   would write now — `DEPLOY_CMS_URL` changed, say — reports `needsRedeploy`.
 *   Existing rows have none and report it until their next deploy: what their
 *   applications hold is unknown.
 * - Backfill `theme_bindings.application_hostname` from the hostname the binding's
 *   latest deployment that reached Coolify was actually deployed on. Bindings kept
 *   the long form (`<site-uuid>-cms-a-preview…`) after deployments moved to the short
 *   one, because the column was only written when an application was created; the
 *   deploy job now keeps it in step.
 * - Drop the hand-added `eshobe_fix_registry_deployment_row` trigger and function on
 *   `site_deployments`. `createDeployment` sets the artifact fields and preview
 *   hostname of a `registry_image` row itself, and `runDeployment` repairs a row that
 *   arrives without them, so the database no longer has to. `CASCADE` removes the
 *   trigger whatever it was named; nothing else can depend on a trigger function.
 *
 * Hand-written like the other recent migrations (the last schema snapshot is stale);
 * every statement is idempotent.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "site_deployments" ADD COLUMN IF NOT EXISTS "platform_env_fingerprint" varchar;

    UPDATE "theme_bindings" AS b
    SET "application_hostname" = latest."preview_domain"
    FROM (
      SELECT DISTINCT ON ("theme_binding_id") "theme_binding_id", "preview_domain"
      FROM "site_deployments"
      WHERE "theme_binding_id" IS NOT NULL
        AND "preview_domain" IS NOT NULL
        AND "preview_domain" <> ''
        AND "app_uuid" IS NOT NULL
      ORDER BY "theme_binding_id", "created_at" DESC
    ) AS latest
    WHERE latest."theme_binding_id" = b."id"
      AND b."application_hostname" IS DISTINCT FROM latest."preview_domain";

    DROP TRIGGER IF EXISTS "eshobe_fix_registry_deployment_row" ON "site_deployments";
    DROP FUNCTION IF EXISTS "public"."eshobe_fix_registry_deployment_row"() CASCADE;
  `)
}

/**
 * The column goes; the hostname backfill is data and stays (the old values were wrong).
 * The trigger is not recreated: it was never part of a migration, and the code that
 * replaced it is what fills those fields now.
 */
export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "site_deployments" DROP COLUMN IF EXISTS "platform_env_fingerprint";
  `)
}
