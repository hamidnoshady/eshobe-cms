import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * One tenant keeps `sites.domain` as its canonical hostname; this table stores
 * additional exact hostnames (`www`, shop, legacy domains). `hostname` has a
 * global unique index, and the two triggers bridge the otherwise-unindexable
 * gap between this table and `sites.domain`.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TABLE "sites_domains" (
      "_order" integer NOT NULL,
      "_parent_id" uuid NOT NULL,
      "id" varchar PRIMARY KEY NOT NULL,
      "hostname" varchar NOT NULL,
      "verified" boolean DEFAULT false
    );

    ALTER TABLE "sites_domains"
      ADD CONSTRAINT "sites_domains_parent_id_fk"
      FOREIGN KEY ("_parent_id") REFERENCES "public"."sites"("id")
      ON DELETE cascade ON UPDATE no action;

    CREATE INDEX "sites_domains_order_idx" ON "sites_domains" USING btree ("_order");
    CREATE INDEX "sites_domains_parent_id_idx" ON "sites_domains" USING btree ("_parent_id");
    CREATE UNIQUE INDEX "sites_domains_hostname_idx" ON "sites_domains" USING btree ("hostname");

    -- The primary-domain column already has its own unique index, but an ordinary
    -- index cannot cover two tables. Lock by hostname first so two concurrent
    -- cross-table writes cannot both observe an empty competing table.
    CREATE FUNCTION "public"."ensure_site_domain_not_alias"() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext(NEW.domain));
      IF EXISTS (SELECT 1 FROM "sites_domains" WHERE "hostname" = NEW.domain) THEN
        RAISE EXCEPTION 'hostname % is already assigned as a tenant alias', NEW.domain
          USING ERRCODE = 'unique_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE FUNCTION "public"."ensure_site_alias_not_domain"() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext(NEW.hostname));
      IF EXISTS (SELECT 1 FROM "sites" WHERE "domain" = NEW.hostname) THEN
        RAISE EXCEPTION 'hostname % is already assigned as a tenant primary domain', NEW.hostname
          USING ERRCODE = 'unique_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER "sites_domain_no_alias_collision"
      BEFORE INSERT OR UPDATE OF "domain" ON "sites"
      FOR EACH ROW EXECUTE FUNCTION "public"."ensure_site_domain_not_alias"();

    CREATE TRIGGER "sites_domains_no_primary_collision"
      BEFORE INSERT OR UPDATE OF "hostname" ON "sites_domains"
      FOR EACH ROW EXECUTE FUNCTION "public"."ensure_site_alias_not_domain"();
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TRIGGER "sites_domains_no_primary_collision" ON "sites_domains";
    DROP TRIGGER "sites_domain_no_alias_collision" ON "sites";
    DROP FUNCTION "public"."ensure_site_alias_not_domain"();
    DROP FUNCTION "public"."ensure_site_domain_not_alias"();
    DROP TABLE "sites_domains";
  `)
}
