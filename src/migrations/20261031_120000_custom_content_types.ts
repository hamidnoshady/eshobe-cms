import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Issue #166 — the native custom content engine.
 *
 * Adds the six tenant-scoped collections (13 tables with locales/rels/
 * array sub-tables):
 *
 * - `content_type_definitions` (+ `field_schema` array, locales, rels):
 *   site-defined custom content types (the WP CPT destination definition).
 * - `taxonomy_definitions` + `taxonomy_terms` (+ locales): named taxonomies
 *   and their (possibly hierarchical) terms; tags stay flat and separate.
 * - `content_entries` (+ locales, rels): records of any defined type with a
 *   WordPress-shaped `status`, typed `field_values`, `unmapped_meta`,
 *   `search_text`, SEO fields and the migration `source_*` provenance group.
 * - `entry_term_relations`: the unique entry↔term edge, taxonomy denormalized.
 * - `content_relations`: typed entry→document edges (single-target columns).
 * - `payload_locked_documents_rels` gains one column per new collection.
 *
 * Hand-written like the other recent migrations. The DDL was taken from a
 * database built with dev push from this exact config, applied over a
 * baseline built by the previous migrations, and the resulting catalog
 * (columns/defaults/indexes/constraints/enums) diffed against the pushed
 * database until identical. Every statement is idempotent, so a retry after
 * a partial deploy cannot fail on its own leftovers.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE "public"."enum_content_entries_source_mapping_status" AS ENUM('manual','imported','archived','blocked');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_content_entries_source_system" AS ENUM('eshobe','wordpress','woocommerce','other');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_content_entries_status" AS ENUM('draft','pending','published','private','scheduled','trash');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_content_relations_source_mapping_status" AS ENUM('manual','imported','archived','blocked');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_content_relations_source_system" AS ENUM('eshobe','wordpress','woocommerce','other');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_content_relations_target_collection" AS ENUM('content-entries','products','posts','pages','media');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_content_type_definitions_field_schema_field_type" AS ENUM('text','textarea','number','boolean','date','url','select','multiselect','media','gallery','relationship','group','repeater','json');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_content_type_definitions_field_schema_relation_to" AS ENUM('content-entries','pages','posts','products','media','taxonomy-terms');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_content_type_definitions_permalink_template" AS ENUM('/{archive}/{slug}','/{archive}/{id}','/{slug}','/{id}');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_content_type_definitions_source_mapping_status" AS ENUM('manual','imported','archived','blocked');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_content_type_definitions_source_system" AS ENUM('eshobe','wordpress','woocommerce','other');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_entry_term_relations_source_mapping_status" AS ENUM('manual','imported','archived','blocked');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_entry_term_relations_source_system" AS ENUM('eshobe','wordpress','woocommerce','other');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_taxonomy_definitions_source_mapping_status" AS ENUM('manual','imported','archived','blocked');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_taxonomy_definitions_source_system" AS ENUM('eshobe','wordpress','woocommerce','other');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_taxonomy_terms_source_mapping_status" AS ENUM('manual','imported','archived','blocked');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_taxonomy_terms_source_system" AS ENUM('eshobe','wordpress','woocommerce','other');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    CREATE TABLE IF NOT EXISTS "content_entries" (
        id uuid DEFAULT gen_random_uuid() NOT NULL,
        site_id uuid,
        content_type_id uuid NOT NULL,
        status "public"."enum_content_entries_status" DEFAULT 'draft'::"public"."enum_content_entries_status" NOT NULL,
        published_at timestamp(3) with time zone,
        hero_image_id uuid,
        og_image_id uuid,
        parent_id uuid,
        menu_order numeric DEFAULT 0,
        author_id uuid,
        author_name varchar,
        field_values jsonb,
        unmapped_meta jsonb,
        search_text varchar,
        canonical_url varchar,
        noindex boolean DEFAULT false,
        source_system "public"."enum_content_entries_source_system" DEFAULT 'eshobe'::"public"."enum_content_entries_source_system" NOT NULL,
        source_mapping_status "public"."enum_content_entries_source_mapping_status" DEFAULT 'manual'::"public"."enum_content_entries_source_mapping_status" NOT NULL,
        source_installation varchar,
        source_source_id varchar,
        source_source_type varchar,
        source_source_status varchar,
        source_source_author_id varchar,
        source_permalink varchar,
        source_modified_at timestamp(3) with time zone,
        source_content_hash varchar,
        source_raw_payload jsonb,
        updated_at timestamp(3) with time zone DEFAULT now() NOT NULL,
        created_at timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "content_entries_locales" (
        title varchar NOT NULL,
        generate_slug boolean DEFAULT true,
        slug varchar NOT NULL,
        excerpt varchar,
        body jsonb,
        preserved_html varchar,
        meta_title varchar,
        meta_description varchar,
        id integer NOT NULL,
        _locale "public"."_locales" NOT NULL,
        _parent_id uuid NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "content_entries_rels" (
        id integer NOT NULL,
        "order" integer,
        parent_id uuid NOT NULL,
        path varchar NOT NULL,
        media_id uuid
    );
    CREATE TABLE IF NOT EXISTS "content_relations" (
        id uuid DEFAULT gen_random_uuid() NOT NULL,
        site_id uuid,
        from_entry_id uuid NOT NULL,
        relation_kind varchar NOT NULL,
        target_collection "public"."enum_content_relations_target_collection" DEFAULT 'content-entries'::"public"."enum_content_relations_target_collection" NOT NULL,
        target_entry_id uuid,
        target_product_id uuid,
        target_post_id uuid,
        target_page_id uuid,
        target_media_id uuid,
        menu_order numeric DEFAULT 0,
        source_system "public"."enum_content_relations_source_system" DEFAULT 'eshobe'::"public"."enum_content_relations_source_system" NOT NULL,
        source_mapping_status "public"."enum_content_relations_source_mapping_status" DEFAULT 'manual'::"public"."enum_content_relations_source_mapping_status" NOT NULL,
        source_installation varchar,
        source_source_id varchar,
        source_source_type varchar,
        source_source_status varchar,
        source_source_author_id varchar,
        source_permalink varchar,
        source_modified_at timestamp(3) with time zone,
        source_content_hash varchar,
        source_raw_payload jsonb,
        updated_at timestamp(3) with time zone DEFAULT now() NOT NULL,
        created_at timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "content_type_definitions" (
        id uuid DEFAULT gen_random_uuid() NOT NULL,
        site_id uuid,
        key varchar NOT NULL,
        hierarchical boolean DEFAULT false,
        has_archive boolean DEFAULT true,
        permalink_template "public"."enum_content_type_definitions_permalink_template" DEFAULT '/{archive}/{slug}'::"public"."enum_content_type_definitions_permalink_template" NOT NULL,
        source_system "public"."enum_content_type_definitions_source_system" DEFAULT 'eshobe'::"public"."enum_content_type_definitions_source_system" NOT NULL,
        source_mapping_status "public"."enum_content_type_definitions_source_mapping_status" DEFAULT 'manual'::"public"."enum_content_type_definitions_source_mapping_status" NOT NULL,
        source_installation varchar,
        source_source_id varchar,
        source_source_type varchar,
        source_source_status varchar,
        source_source_author_id varchar,
        source_permalink varchar,
        source_modified_at timestamp(3) with time zone,
        source_content_hash varchar,
        source_raw_payload jsonb,
        updated_at timestamp(3) with time zone DEFAULT now() NOT NULL,
        created_at timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "content_type_definitions_field_schema" (
        _order integer NOT NULL,
        _parent_id uuid NOT NULL,
        id varchar NOT NULL,
        key varchar NOT NULL,
        label varchar NOT NULL,
        field_type "public"."enum_content_type_definitions_field_schema_field_type" DEFAULT 'text'::"public"."enum_content_type_definitions_field_schema_field_type" NOT NULL,
        required boolean DEFAULT false,
        searchable boolean DEFAULT false,
        options_text varchar,
        relation_to "public"."enum_content_type_definitions_field_schema_relation_to",
        sub_schema jsonb,
        help_text varchar
    );
    CREATE TABLE IF NOT EXISTS "content_type_definitions_locales" (
        singular_label varchar NOT NULL,
        plural_label varchar NOT NULL,
        description varchar,
        archive_slug varchar,
        id integer NOT NULL,
        _locale "public"."_locales" NOT NULL,
        _parent_id uuid NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "content_type_definitions_rels" (
        id integer NOT NULL,
        "order" integer,
        parent_id uuid NOT NULL,
        path varchar NOT NULL,
        taxonomy_definitions_id uuid
    );
    CREATE TABLE IF NOT EXISTS "entry_term_relations" (
        id uuid DEFAULT gen_random_uuid() NOT NULL,
        site_id uuid,
        entry_id uuid NOT NULL,
        term_id uuid NOT NULL,
        taxonomy_id uuid NOT NULL,
        menu_order numeric DEFAULT 0,
        source_system "public"."enum_entry_term_relations_source_system" DEFAULT 'eshobe'::"public"."enum_entry_term_relations_source_system" NOT NULL,
        source_mapping_status "public"."enum_entry_term_relations_source_mapping_status" DEFAULT 'manual'::"public"."enum_entry_term_relations_source_mapping_status" NOT NULL,
        source_installation varchar,
        source_source_id varchar,
        source_source_type varchar,
        source_source_status varchar,
        source_source_author_id varchar,
        source_permalink varchar,
        source_modified_at timestamp(3) with time zone,
        source_content_hash varchar,
        source_raw_payload jsonb,
        updated_at timestamp(3) with time zone DEFAULT now() NOT NULL,
        created_at timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "taxonomy_definitions" (
        id uuid DEFAULT gen_random_uuid() NOT NULL,
        site_id uuid,
        key varchar NOT NULL,
        hierarchical boolean DEFAULT false,
        has_archive boolean DEFAULT true,
        source_system "public"."enum_taxonomy_definitions_source_system" DEFAULT 'eshobe'::"public"."enum_taxonomy_definitions_source_system" NOT NULL,
        source_mapping_status "public"."enum_taxonomy_definitions_source_mapping_status" DEFAULT 'manual'::"public"."enum_taxonomy_definitions_source_mapping_status" NOT NULL,
        source_installation varchar,
        source_source_id varchar,
        source_source_type varchar,
        source_source_status varchar,
        source_source_author_id varchar,
        source_permalink varchar,
        source_modified_at timestamp(3) with time zone,
        source_content_hash varchar,
        source_raw_payload jsonb,
        updated_at timestamp(3) with time zone DEFAULT now() NOT NULL,
        created_at timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "taxonomy_definitions_locales" (
        singular_label varchar NOT NULL,
        plural_label varchar NOT NULL,
        description varchar,
        archive_slug varchar,
        id integer NOT NULL,
        _locale "public"."_locales" NOT NULL,
        _parent_id uuid NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "taxonomy_terms" (
        id uuid DEFAULT gen_random_uuid() NOT NULL,
        site_id uuid,
        taxonomy_id uuid NOT NULL,
        parent_id uuid,
        menu_order numeric DEFAULT 0,
        source_term_taxonomy_id varchar,
        legacy_archive_url varchar,
        meta jsonb,
        source_system "public"."enum_taxonomy_terms_source_system" DEFAULT 'eshobe'::"public"."enum_taxonomy_terms_source_system" NOT NULL,
        source_mapping_status "public"."enum_taxonomy_terms_source_mapping_status" DEFAULT 'manual'::"public"."enum_taxonomy_terms_source_mapping_status" NOT NULL,
        source_installation varchar,
        source_source_id varchar,
        source_source_type varchar,
        source_source_status varchar,
        source_source_author_id varchar,
        source_permalink varchar,
        source_modified_at timestamp(3) with time zone,
        source_content_hash varchar,
        source_raw_payload jsonb,
        updated_at timestamp(3) with time zone DEFAULT now() NOT NULL,
        created_at timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "taxonomy_terms_locales" (
        name varchar NOT NULL,
        generate_slug boolean DEFAULT true,
        slug varchar NOT NULL,
        description varchar,
        id integer NOT NULL,
        _locale "public"."_locales" NOT NULL,
        _parent_id uuid NOT NULL
    );
    CREATE SEQUENCE IF NOT EXISTS "content_entries_locales_id_seq"
        AS integer
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE "content_entries_locales_id_seq" OWNED BY "content_entries_locales"."id";
    CREATE SEQUENCE IF NOT EXISTS "content_entries_rels_id_seq"
        AS integer
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE "content_entries_rels_id_seq" OWNED BY "content_entries_rels"."id";
    CREATE SEQUENCE IF NOT EXISTS "content_type_definitions_locales_id_seq"
        AS integer
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE "content_type_definitions_locales_id_seq" OWNED BY "content_type_definitions_locales"."id";
    CREATE SEQUENCE IF NOT EXISTS "content_type_definitions_rels_id_seq"
        AS integer
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE "content_type_definitions_rels_id_seq" OWNED BY "content_type_definitions_rels"."id";
    CREATE SEQUENCE IF NOT EXISTS "taxonomy_definitions_locales_id_seq"
        AS integer
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE "taxonomy_definitions_locales_id_seq" OWNED BY "taxonomy_definitions_locales"."id";
    CREATE SEQUENCE IF NOT EXISTS "taxonomy_terms_locales_id_seq"
        AS integer
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE "taxonomy_terms_locales_id_seq" OWNED BY "taxonomy_terms_locales"."id";
    ALTER TABLE "content_entries_locales" ALTER COLUMN id SET DEFAULT nextval('"public"."content_entries_locales_id_seq"'::regclass);
    ALTER TABLE "content_entries_rels" ALTER COLUMN id SET DEFAULT nextval('"public"."content_entries_rels_id_seq"'::regclass);
    ALTER TABLE "content_type_definitions_locales" ALTER COLUMN id SET DEFAULT nextval('"public"."content_type_definitions_locales_id_seq"'::regclass);
    ALTER TABLE "content_type_definitions_rels" ALTER COLUMN id SET DEFAULT nextval('"public"."content_type_definitions_rels_id_seq"'::regclass);
    ALTER TABLE "taxonomy_definitions_locales" ALTER COLUMN id SET DEFAULT nextval('"public"."taxonomy_definitions_locales_id_seq"'::regclass);
    ALTER TABLE "taxonomy_terms_locales" ALTER COLUMN id SET DEFAULT nextval('"public"."taxonomy_terms_locales_id_seq"'::regclass);
    DO $$ BEGIN
      ALTER TABLE "content_entries_locales"
          ADD CONSTRAINT content_entries_locales_pkey PRIMARY KEY (id);
    EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_entries"
          ADD CONSTRAINT content_entries_pkey PRIMARY KEY (id);
    EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_entries_rels"
          ADD CONSTRAINT content_entries_rels_pkey PRIMARY KEY (id);
    EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_relations"
          ADD CONSTRAINT content_relations_pkey PRIMARY KEY (id);
    EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_type_definitions_field_schema"
          ADD CONSTRAINT content_type_definitions_field_schema_pkey PRIMARY KEY (id);
    EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_type_definitions_locales"
          ADD CONSTRAINT content_type_definitions_locales_pkey PRIMARY KEY (id);
    EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_type_definitions"
          ADD CONSTRAINT content_type_definitions_pkey PRIMARY KEY (id);
    EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_type_definitions_rels"
          ADD CONSTRAINT content_type_definitions_rels_pkey PRIMARY KEY (id);
    EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "entry_term_relations"
          ADD CONSTRAINT entry_term_relations_pkey PRIMARY KEY (id);
    EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "taxonomy_definitions_locales"
          ADD CONSTRAINT taxonomy_definitions_locales_pkey PRIMARY KEY (id);
    EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "taxonomy_definitions"
          ADD CONSTRAINT taxonomy_definitions_pkey PRIMARY KEY (id);
    EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "taxonomy_terms_locales"
          ADD CONSTRAINT taxonomy_terms_locales_pkey PRIMARY KEY (id);
    EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "taxonomy_terms"
          ADD CONSTRAINT taxonomy_terms_pkey PRIMARY KEY (id);
    EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    CREATE INDEX IF NOT EXISTS "content_entries_author_idx" ON "public"."content_entries" USING btree (author_id);
    CREATE INDEX IF NOT EXISTS "content_entries_content_type_idx" ON "public"."content_entries" USING btree (content_type_id);
    CREATE INDEX IF NOT EXISTS "content_entries_created_at_idx" ON "public"."content_entries" USING btree (created_at);
    CREATE INDEX IF NOT EXISTS "content_entries_hero_image_idx" ON "public"."content_entries" USING btree (hero_image_id);
    CREATE UNIQUE INDEX IF NOT EXISTS "content_entries_locales_locale_parent_id_unique" ON "public"."content_entries_locales" USING btree (_locale, _parent_id);
    CREATE INDEX IF NOT EXISTS "content_entries_og_image_idx" ON "public"."content_entries" USING btree (og_image_id);
    CREATE INDEX IF NOT EXISTS "content_entries_parent_idx" ON "public"."content_entries" USING btree (parent_id);
    CREATE INDEX IF NOT EXISTS "content_entries_rels_media_id_idx" ON "public"."content_entries_rels" USING btree (media_id);
    CREATE INDEX IF NOT EXISTS "content_entries_rels_order_idx" ON "public"."content_entries_rels" USING btree ("order");
    CREATE INDEX IF NOT EXISTS "content_entries_rels_parent_idx" ON "public"."content_entries_rels" USING btree (parent_id);
    CREATE INDEX IF NOT EXISTS "content_entries_rels_path_idx" ON "public"."content_entries_rels" USING btree (path);
    CREATE INDEX IF NOT EXISTS "content_entries_search_text_idx" ON "public"."content_entries" USING btree (search_text);
    CREATE INDEX IF NOT EXISTS "content_entries_site_idx" ON "public"."content_entries" USING btree (site_id);
    CREATE INDEX IF NOT EXISTS "content_entries_slug_idx" ON "public"."content_entries_locales" USING btree (slug, _locale);
    CREATE INDEX IF NOT EXISTS "content_entries_source_source_source_id_idx" ON "public"."content_entries" USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS "content_entries_source_source_system_idx" ON "public"."content_entries" USING btree (source_system);
    CREATE INDEX IF NOT EXISTS "content_entries_status_idx" ON "public"."content_entries" USING btree (status);
    CREATE INDEX IF NOT EXISTS "content_entries_updated_at_idx" ON "public"."content_entries" USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS "content_relations_created_at_idx" ON "public"."content_relations" USING btree (created_at);
    CREATE INDEX IF NOT EXISTS "content_relations_from_entry_idx" ON "public"."content_relations" USING btree (from_entry_id);
    CREATE INDEX IF NOT EXISTS "content_relations_relation_kind_idx" ON "public"."content_relations" USING btree (relation_kind);
    CREATE INDEX IF NOT EXISTS "content_relations_site_idx" ON "public"."content_relations" USING btree (site_id);
    CREATE INDEX IF NOT EXISTS "content_relations_source_source_source_id_idx" ON "public"."content_relations" USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS "content_relations_source_source_system_idx" ON "public"."content_relations" USING btree (source_system);
    CREATE INDEX IF NOT EXISTS "content_relations_target_entry_idx" ON "public"."content_relations" USING btree (target_entry_id);
    CREATE INDEX IF NOT EXISTS "content_relations_target_media_idx" ON "public"."content_relations" USING btree (target_media_id);
    CREATE INDEX IF NOT EXISTS "content_relations_target_page_idx" ON "public"."content_relations" USING btree (target_page_id);
    CREATE INDEX IF NOT EXISTS "content_relations_target_post_idx" ON "public"."content_relations" USING btree (target_post_id);
    CREATE INDEX IF NOT EXISTS "content_relations_target_product_idx" ON "public"."content_relations" USING btree (target_product_id);
    CREATE INDEX IF NOT EXISTS "content_relations_updated_at_idx" ON "public"."content_relations" USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS "content_type_definitions_created_at_idx" ON "public"."content_type_definitions" USING btree (created_at);
    CREATE INDEX IF NOT EXISTS "content_type_definitions_field_schema_order_idx" ON "public"."content_type_definitions_field_schema" USING btree (_order);
    CREATE INDEX IF NOT EXISTS "content_type_definitions_field_schema_parent_id_idx" ON "public"."content_type_definitions_field_schema" USING btree (_parent_id);
    CREATE INDEX IF NOT EXISTS "content_type_definitions_key_idx" ON "public"."content_type_definitions" USING btree (key);
    CREATE UNIQUE INDEX IF NOT EXISTS "content_type_definitions_locales_locale_parent_id_unique" ON "public"."content_type_definitions_locales" USING btree (_locale, _parent_id);
    CREATE INDEX IF NOT EXISTS "content_type_definitions_rels_order_idx" ON "public"."content_type_definitions_rels" USING btree ("order");
    CREATE INDEX IF NOT EXISTS "content_type_definitions_rels_parent_idx" ON "public"."content_type_definitions_rels" USING btree (parent_id);
    CREATE INDEX IF NOT EXISTS "content_type_definitions_rels_path_idx" ON "public"."content_type_definitions_rels" USING btree (path);
    CREATE INDEX IF NOT EXISTS "content_type_definitions_rels_taxonomy_definitions_id_idx" ON "public"."content_type_definitions_rels" USING btree (taxonomy_definitions_id);
    CREATE INDEX IF NOT EXISTS "content_type_definitions_site_idx" ON "public"."content_type_definitions" USING btree (site_id);
    CREATE INDEX IF NOT EXISTS "content_type_definitions_source_source_source_id_idx" ON "public"."content_type_definitions" USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS "content_type_definitions_source_source_system_idx" ON "public"."content_type_definitions" USING btree (source_system);
    CREATE INDEX IF NOT EXISTS "content_type_definitions_updated_at_idx" ON "public"."content_type_definitions" USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS "entry_term_relations_created_at_idx" ON "public"."entry_term_relations" USING btree (created_at);
    CREATE INDEX IF NOT EXISTS "entry_term_relations_entry_idx" ON "public"."entry_term_relations" USING btree (entry_id);
    CREATE INDEX IF NOT EXISTS "entry_term_relations_site_idx" ON "public"."entry_term_relations" USING btree (site_id);
    CREATE INDEX IF NOT EXISTS "entry_term_relations_source_source_source_id_idx" ON "public"."entry_term_relations" USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS "entry_term_relations_source_source_system_idx" ON "public"."entry_term_relations" USING btree (source_system);
    CREATE INDEX IF NOT EXISTS "entry_term_relations_taxonomy_idx" ON "public"."entry_term_relations" USING btree (taxonomy_id);
    CREATE INDEX IF NOT EXISTS "entry_term_relations_term_idx" ON "public"."entry_term_relations" USING btree (term_id);
    CREATE INDEX IF NOT EXISTS "entry_term_relations_updated_at_idx" ON "public"."entry_term_relations" USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS "taxonomy_definitions_created_at_idx" ON "public"."taxonomy_definitions" USING btree (created_at);
    CREATE INDEX IF NOT EXISTS "taxonomy_definitions_key_idx" ON "public"."taxonomy_definitions" USING btree (key);
    CREATE UNIQUE INDEX IF NOT EXISTS "taxonomy_definitions_locales_locale_parent_id_unique" ON "public"."taxonomy_definitions_locales" USING btree (_locale, _parent_id);
    CREATE INDEX IF NOT EXISTS "taxonomy_definitions_site_idx" ON "public"."taxonomy_definitions" USING btree (site_id);
    CREATE INDEX IF NOT EXISTS "taxonomy_definitions_source_source_source_id_idx" ON "public"."taxonomy_definitions" USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS "taxonomy_definitions_source_source_system_idx" ON "public"."taxonomy_definitions" USING btree (source_system);
    CREATE INDEX IF NOT EXISTS "taxonomy_definitions_updated_at_idx" ON "public"."taxonomy_definitions" USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS "taxonomy_terms_created_at_idx" ON "public"."taxonomy_terms" USING btree (created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS "taxonomy_terms_locales_locale_parent_id_unique" ON "public"."taxonomy_terms_locales" USING btree (_locale, _parent_id);
    CREATE INDEX IF NOT EXISTS "taxonomy_terms_parent_idx" ON "public"."taxonomy_terms" USING btree (parent_id);
    CREATE INDEX IF NOT EXISTS "taxonomy_terms_site_idx" ON "public"."taxonomy_terms" USING btree (site_id);
    CREATE INDEX IF NOT EXISTS "taxonomy_terms_slug_idx" ON "public"."taxonomy_terms_locales" USING btree (slug, _locale);
    CREATE INDEX IF NOT EXISTS "taxonomy_terms_source_source_source_id_idx" ON "public"."taxonomy_terms" USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS "taxonomy_terms_source_source_system_idx" ON "public"."taxonomy_terms" USING btree (source_system);
    CREATE INDEX IF NOT EXISTS "taxonomy_terms_source_term_taxonomy_id_idx" ON "public"."taxonomy_terms" USING btree (source_term_taxonomy_id);
    CREATE INDEX IF NOT EXISTS "taxonomy_terms_taxonomy_idx" ON "public"."taxonomy_terms" USING btree (taxonomy_id);
    CREATE INDEX IF NOT EXISTS "taxonomy_terms_updated_at_idx" ON "public"."taxonomy_terms" USING btree (updated_at);
    DO $$ BEGIN
      ALTER TABLE "content_entries"
          ADD CONSTRAINT content_entries_author_id_users_id_fk FOREIGN KEY (author_id) REFERENCES "public"."users"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_entries"
          ADD CONSTRAINT content_entries_content_type_id_content_type_definitions_id_fk FOREIGN KEY (content_type_id) REFERENCES "public"."content_type_definitions"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_entries"
          ADD CONSTRAINT content_entries_hero_image_id_media_id_fk FOREIGN KEY (hero_image_id) REFERENCES "public"."media"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_entries_locales"
          ADD CONSTRAINT content_entries_locales_parent_id_fk FOREIGN KEY (_parent_id) REFERENCES "public"."content_entries"(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_entries"
          ADD CONSTRAINT content_entries_og_image_id_media_id_fk FOREIGN KEY (og_image_id) REFERENCES "public"."media"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_entries"
          ADD CONSTRAINT content_entries_parent_id_content_entries_id_fk FOREIGN KEY (parent_id) REFERENCES "public"."content_entries"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_entries_rels"
          ADD CONSTRAINT content_entries_rels_media_fk FOREIGN KEY (media_id) REFERENCES "public"."media"(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_entries_rels"
          ADD CONSTRAINT content_entries_rels_parent_fk FOREIGN KEY (parent_id) REFERENCES "public"."content_entries"(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_entries"
          ADD CONSTRAINT content_entries_site_id_sites_id_fk FOREIGN KEY (site_id) REFERENCES "public"."sites"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_relations"
          ADD CONSTRAINT content_relations_from_entry_id_content_entries_id_fk FOREIGN KEY (from_entry_id) REFERENCES "public"."content_entries"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_relations"
          ADD CONSTRAINT content_relations_site_id_sites_id_fk FOREIGN KEY (site_id) REFERENCES "public"."sites"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_relations"
          ADD CONSTRAINT content_relations_target_entry_id_content_entries_id_fk FOREIGN KEY (target_entry_id) REFERENCES "public"."content_entries"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_relations"
          ADD CONSTRAINT content_relations_target_media_id_media_id_fk FOREIGN KEY (target_media_id) REFERENCES "public"."media"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_relations"
          ADD CONSTRAINT content_relations_target_page_id_pages_id_fk FOREIGN KEY (target_page_id) REFERENCES "public"."pages"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_relations"
          ADD CONSTRAINT content_relations_target_post_id_posts_id_fk FOREIGN KEY (target_post_id) REFERENCES "public"."posts"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_relations"
          ADD CONSTRAINT content_relations_target_product_id_products_id_fk FOREIGN KEY (target_product_id) REFERENCES "public"."products"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_type_definitions_field_schema"
          ADD CONSTRAINT content_type_definitions_field_schema_parent_id_fk FOREIGN KEY (_parent_id) REFERENCES "public"."content_type_definitions"(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_type_definitions_locales"
          ADD CONSTRAINT content_type_definitions_locales_parent_id_fk FOREIGN KEY (_parent_id) REFERENCES "public"."content_type_definitions"(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_type_definitions_rels"
          ADD CONSTRAINT content_type_definitions_rels_parent_fk FOREIGN KEY (parent_id) REFERENCES "public"."content_type_definitions"(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_type_definitions_rels"
          ADD CONSTRAINT content_type_definitions_rels_taxonomy_definitions_fk FOREIGN KEY (taxonomy_definitions_id) REFERENCES "public"."taxonomy_definitions"(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "content_type_definitions"
          ADD CONSTRAINT content_type_definitions_site_id_sites_id_fk FOREIGN KEY (site_id) REFERENCES "public"."sites"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "entry_term_relations"
          ADD CONSTRAINT entry_term_relations_entry_id_content_entries_id_fk FOREIGN KEY (entry_id) REFERENCES "public"."content_entries"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "entry_term_relations"
          ADD CONSTRAINT entry_term_relations_site_id_sites_id_fk FOREIGN KEY (site_id) REFERENCES "public"."sites"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "entry_term_relations"
          ADD CONSTRAINT entry_term_relations_taxonomy_id_taxonomy_definitions_id_fk FOREIGN KEY (taxonomy_id) REFERENCES "public"."taxonomy_definitions"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "entry_term_relations"
          ADD CONSTRAINT entry_term_relations_term_id_taxonomy_terms_id_fk FOREIGN KEY (term_id) REFERENCES "public"."taxonomy_terms"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "taxonomy_definitions_locales"
          ADD CONSTRAINT taxonomy_definitions_locales_parent_id_fk FOREIGN KEY (_parent_id) REFERENCES "public"."taxonomy_definitions"(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "taxonomy_definitions"
          ADD CONSTRAINT taxonomy_definitions_site_id_sites_id_fk FOREIGN KEY (site_id) REFERENCES "public"."sites"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "taxonomy_terms_locales"
          ADD CONSTRAINT taxonomy_terms_locales_parent_id_fk FOREIGN KEY (_parent_id) REFERENCES "public"."taxonomy_terms"(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "taxonomy_terms"
          ADD CONSTRAINT taxonomy_terms_parent_id_taxonomy_terms_id_fk FOREIGN KEY (parent_id) REFERENCES "public"."taxonomy_terms"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "taxonomy_terms"
          ADD CONSTRAINT taxonomy_terms_site_id_sites_id_fk FOREIGN KEY (site_id) REFERENCES "public"."sites"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "taxonomy_terms"
          ADD CONSTRAINT taxonomy_terms_taxonomy_id_taxonomy_definitions_id_fk FOREIGN KEY (taxonomy_id) REFERENCES "public"."taxonomy_definitions"(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    -- Locked-document relations for the six new collections.
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "content_entries_id" uuid;
    DO $$ BEGIN
      ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_content_entries_fk"
        FOREIGN KEY ("content_entries_id") REFERENCES "public"."content_entries"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_content_entries_id_idx" ON "payload_locked_documents_rels" USING btree ("content_entries_id");
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "content_relations_id" uuid;
    DO $$ BEGIN
      ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_content_relations_fk"
        FOREIGN KEY ("content_relations_id") REFERENCES "public"."content_relations"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_content_relations_id_idx" ON "payload_locked_documents_rels" USING btree ("content_relations_id");
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "content_type_definitions_id" uuid;
    DO $$ BEGIN
      ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_content_type_definitions_fk"
        FOREIGN KEY ("content_type_definitions_id") REFERENCES "public"."content_type_definitions"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_content_type_definitions_i_idx" ON "payload_locked_documents_rels" USING btree ("content_type_definitions_id");
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "entry_term_relations_id" uuid;
    DO $$ BEGIN
      ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_entry_term_relations_fk"
        FOREIGN KEY ("entry_term_relations_id") REFERENCES "public"."entry_term_relations"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_entry_term_relations_id_idx" ON "payload_locked_documents_rels" USING btree ("entry_term_relations_id");
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "taxonomy_definitions_id" uuid;
    DO $$ BEGIN
      ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_taxonomy_definitions_fk"
        FOREIGN KEY ("taxonomy_definitions_id") REFERENCES "public"."taxonomy_definitions"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_taxonomy_definitions_id_idx" ON "payload_locked_documents_rels" USING btree ("taxonomy_definitions_id");
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "taxonomy_terms_id" uuid;
    DO $$ BEGIN
      ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_taxonomy_terms_fk"
        FOREIGN KEY ("taxonomy_terms_id") REFERENCES "public"."taxonomy_terms"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_taxonomy_terms_id_idx" ON "payload_locked_documents_rels" USING btree ("taxonomy_terms_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_content_entries_fk";
    DROP INDEX IF EXISTS "payload_locked_documents_rels_content_entries_id_idx";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "content_entries_id";
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_content_relations_fk";
    DROP INDEX IF EXISTS "payload_locked_documents_rels_content_relations_id_idx";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "content_relations_id";
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_content_type_definitions_fk";
    DROP INDEX IF EXISTS "payload_locked_documents_rels_content_type_definitions_i_idx";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "content_type_definitions_id";
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_entry_term_relations_fk";
    DROP INDEX IF EXISTS "payload_locked_documents_rels_entry_term_relations_id_idx";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "entry_term_relations_id";
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_taxonomy_definitions_fk";
    DROP INDEX IF EXISTS "payload_locked_documents_rels_taxonomy_definitions_id_idx";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "taxonomy_definitions_id";
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_taxonomy_terms_fk";
    DROP INDEX IF EXISTS "payload_locked_documents_rels_taxonomy_terms_id_idx";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "taxonomy_terms_id";
    DROP TABLE IF EXISTS "content_entries_locales" CASCADE;
    DROP TABLE IF EXISTS "content_entries_rels" CASCADE;
    DROP TABLE IF EXISTS "entry_term_relations" CASCADE;
    DROP TABLE IF EXISTS "content_relations" CASCADE;
    DROP TABLE IF EXISTS "content_entries" CASCADE;
    DROP TABLE IF EXISTS "taxonomy_terms_locales" CASCADE;
    DROP TABLE IF EXISTS "taxonomy_terms" CASCADE;
    DROP TABLE IF EXISTS "content_type_definitions_field_schema" CASCADE;
    DROP TABLE IF EXISTS "content_type_definitions_locales" CASCADE;
    DROP TABLE IF EXISTS "content_type_definitions_rels" CASCADE;
    DROP TABLE IF EXISTS "content_type_definitions" CASCADE;
    DROP TABLE IF EXISTS "taxonomy_definitions_locales" CASCADE;
    DROP TABLE IF EXISTS "taxonomy_definitions" CASCADE;
    DROP TYPE IF EXISTS "public"."enum_content_entries_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum_content_entries_source_system";
    DROP TYPE IF EXISTS "public"."enum_content_entries_status";
    DROP TYPE IF EXISTS "public"."enum_content_relations_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum_content_relations_source_system";
    DROP TYPE IF EXISTS "public"."enum_content_relations_target_collection";
    DROP TYPE IF EXISTS "public"."enum_content_type_definitions_field_schema_field_type";
    DROP TYPE IF EXISTS "public"."enum_content_type_definitions_field_schema_relation_to";
    DROP TYPE IF EXISTS "public"."enum_content_type_definitions_permalink_template";
    DROP TYPE IF EXISTS "public"."enum_content_type_definitions_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum_content_type_definitions_source_system";
    DROP TYPE IF EXISTS "public"."enum_entry_term_relations_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum_entry_term_relations_source_system";
    DROP TYPE IF EXISTS "public"."enum_taxonomy_definitions_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum_taxonomy_definitions_source_system";
    DROP TYPE IF EXISTS "public"."enum_taxonomy_terms_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum_taxonomy_terms_source_system";
  `)
}
