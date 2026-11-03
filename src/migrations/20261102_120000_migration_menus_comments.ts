import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Issue #166 follow-up — native WordPress menus and comments.
 *
 * Adds the tenant-scoped `menus` and `comments` destinations used by the
 * Migration Center, including localized menu/comment bodies, the flat
 * ordered menu-item table, and Payload's polymorphic `menus_rels` join.
 *
 * The DDL is hand-checked against the catalog Payload dev-pushes for the
 * two collections on this branch. It is deliberately additive: no existing
 * table, column, index or enum is altered. Creation is idempotent where
 * Postgres permits it so a retry after a partial deploy converges.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    DO $$ BEGIN
          create type "public"."enum_comments_source_mapping_status" as enum ('manual', 'imported', 'archived', 'blocked');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_comments_source_system" as enum ('eshobe', 'wordpress', 'woocommerce', 'other');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_comments_status" as enum ('approved', 'pending', 'spam', 'trash');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_comments_target_collection" as enum ('posts', 'pages', 'products', 'content-entries');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_menus_items_status" as enum ('published', 'draft', 'pending', 'private', 'scheduled', 'trash');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_menus_items_type" as enum ('reference', 'custom');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_menus_source_mapping_status" as enum ('manual', 'imported', 'archived', 'blocked');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_menus_source_system" as enum ('eshobe', 'wordpress', 'woocommerce', 'other');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE SEQUENCE IF NOT EXISTS "public"."comments_locales_id_seq";
    CREATE SEQUENCE IF NOT EXISTS "public"."menus_items_locales_id_seq";
    CREATE SEQUENCE IF NOT EXISTS "public"."menus_locales_id_seq";
    CREATE SEQUENCE IF NOT EXISTS "public"."menus_rels_id_seq";
    CREATE TABLE IF NOT EXISTS "public"."comments" (
        id uuid DEFAULT gen_random_uuid() NOT NULL,
        site_id uuid,
        status public.enum_comments_status DEFAULT 'pending'::public.enum_comments_status NOT NULL,
        submitted_at timestamp(3) with time zone,
        comment_type character varying DEFAULT 'comment'::character varying,
        rating numeric,
        target_collection public.enum_comments_target_collection DEFAULT 'posts'::public.enum_comments_target_collection NOT NULL,
        target_post_id uuid,
        target_page_id uuid,
        target_product_id uuid,
        target_entry_id uuid,
        parent_id uuid,
        author_name character varying,
        author_url character varying,
        author_email character varying,
        author_user_id uuid,
        author_customer_id uuid,
        source_system public.enum_comments_source_system DEFAULT 'eshobe'::public.enum_comments_source_system,
        source_mapping_status public.enum_comments_source_mapping_status DEFAULT 'manual'::public.enum_comments_source_mapping_status,
        source_installation character varying,
        source_source_id character varying,
        source_source_type character varying,
        source_source_status character varying,
        source_source_author_id character varying,
        source_permalink character varying,
        source_modified_at timestamp(3) with time zone,
        source_content_hash character varying,
        source_raw_payload jsonb,
        updated_at timestamp(3) with time zone DEFAULT now() NOT NULL,
        created_at timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "public"."comments_locales" (
        body jsonb NOT NULL,
        id integer not null default nextval('comments_locales_id_seq'::regclass),
        _locale public._locales NOT NULL,
        _parent_id uuid NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "public"."menus" (
        id uuid DEFAULT gen_random_uuid() NOT NULL,
        site_id uuid,
        slug character varying NOT NULL,
        is_active boolean DEFAULT true,
        location character varying,
        locations jsonb,
        source_system public.enum_menus_source_system DEFAULT 'eshobe'::public.enum_menus_source_system,
        source_mapping_status public.enum_menus_source_mapping_status DEFAULT 'manual'::public.enum_menus_source_mapping_status,
        source_installation character varying,
        source_source_id character varying,
        source_source_type character varying,
        source_source_status character varying,
        source_source_author_id character varying,
        source_permalink character varying,
        source_modified_at timestamp(3) with time zone,
        source_content_hash character varying,
        source_raw_payload jsonb,
        updated_at timestamp(3) with time zone DEFAULT now() NOT NULL,
        created_at timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "public"."menus_items" (
        _order integer NOT NULL,
        _parent_id uuid NOT NULL,
        id character varying NOT NULL,
        key character varying NOT NULL,
        parent_key character varying,
        type public.enum_menus_items_type DEFAULT 'custom'::public.enum_menus_items_type NOT NULL,
        new_tab boolean DEFAULT false,
        menu_order numeric DEFAULT 0,
        depth numeric DEFAULT 0,
        status public.enum_menus_items_status DEFAULT 'published'::public.enum_menus_items_status NOT NULL,
        css_classes character varying,
        source_object_type character varying,
        source_object_id character varying,
        source_url character varying
    );
    CREATE TABLE IF NOT EXISTS "public"."menus_items_locales" (
        label character varying NOT NULL,
        description character varying,
        url character varying,
        id integer not null default nextval('menus_items_locales_id_seq'::regclass),
        _locale public._locales NOT NULL,
        _parent_id character varying NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "public"."menus_locales" (
        name character varying NOT NULL,
        description character varying,
        id integer not null default nextval('menus_locales_id_seq'::regclass),
        _locale public._locales NOT NULL,
        _parent_id uuid NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "public"."menus_rels" (
        id integer not null default nextval('menus_rels_id_seq'::regclass),
        "order" integer,
        parent_id uuid NOT NULL,
        path character varying NOT NULL,
        pages_id uuid,
        posts_id uuid,
        products_id uuid,
        content_entries_id uuid,
        categories_id uuid,
        taxonomy_terms_id uuid,
        media_id uuid
    );
    ALTER SEQUENCE "public"."comments_locales_id_seq" OWNED BY "public"."comments_locales"."id";
    ALTER SEQUENCE "public"."menus_items_locales_id_seq" OWNED BY "public"."menus_items_locales"."id";
    ALTER SEQUENCE "public"."menus_locales_id_seq" OWNED BY "public"."menus_locales"."id";
    ALTER SEQUENCE "public"."menus_rels_id_seq" OWNED BY "public"."menus_rels"."id";
    CREATE INDEX IF NOT EXISTS comments_author_customer_idx ON "public".comments USING btree (author_customer_id);
    CREATE INDEX IF NOT EXISTS comments_author_user_idx ON "public".comments USING btree (author_user_id);
    CREATE INDEX IF NOT EXISTS comments_comment_type_idx ON "public".comments USING btree (comment_type);
    CREATE INDEX IF NOT EXISTS comments_created_at_idx ON "public".comments USING btree (created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS comments_locales_locale_parent_id_unique ON "public".comments_locales USING btree (_locale, _parent_id);
    CREATE INDEX IF NOT EXISTS comments_parent_idx ON "public".comments USING btree (parent_id);
    CREATE INDEX IF NOT EXISTS comments_site_idx ON "public".comments USING btree (site_id);
    CREATE INDEX IF NOT EXISTS comments_source_source_source_id_idx ON "public".comments USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS comments_source_source_system_idx ON "public".comments USING btree (source_system);
    CREATE INDEX IF NOT EXISTS comments_status_idx ON "public".comments USING btree (status);
    CREATE INDEX IF NOT EXISTS comments_submitted_at_idx ON "public".comments USING btree (submitted_at);
    CREATE INDEX IF NOT EXISTS comments_target_entry_idx ON "public".comments USING btree (target_entry_id);
    CREATE INDEX IF NOT EXISTS comments_target_page_idx ON "public".comments USING btree (target_page_id);
    CREATE INDEX IF NOT EXISTS comments_target_post_idx ON "public".comments USING btree (target_post_id);
    CREATE INDEX IF NOT EXISTS comments_target_product_idx ON "public".comments USING btree (target_product_id);
    CREATE INDEX IF NOT EXISTS comments_updated_at_idx ON "public".comments USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS menus_created_at_idx ON "public".menus USING btree (created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS menus_items_locales_locale_parent_id_unique ON "public".menus_items_locales USING btree (_locale, _parent_id);
    CREATE INDEX IF NOT EXISTS menus_items_order_idx ON "public".menus_items USING btree (_order);
    CREATE INDEX IF NOT EXISTS menus_items_parent_id_idx ON "public".menus_items USING btree (_parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS menus_locales_locale_parent_id_unique ON "public".menus_locales USING btree (_locale, _parent_id);
    CREATE INDEX IF NOT EXISTS menus_location_idx ON "public".menus USING btree (location);
    CREATE INDEX IF NOT EXISTS menus_rels_categories_id_idx ON "public".menus_rels USING btree (categories_id);
    CREATE INDEX IF NOT EXISTS menus_rels_content_entries_id_idx ON "public".menus_rels USING btree (content_entries_id);
    CREATE INDEX IF NOT EXISTS menus_rels_media_id_idx ON "public".menus_rels USING btree (media_id);
    CREATE INDEX IF NOT EXISTS menus_rels_order_idx ON "public".menus_rels USING btree ("order");
    CREATE INDEX IF NOT EXISTS menus_rels_pages_id_idx ON "public".menus_rels USING btree (pages_id);
    CREATE INDEX IF NOT EXISTS menus_rels_parent_idx ON "public".menus_rels USING btree (parent_id);
    CREATE INDEX IF NOT EXISTS menus_rels_path_idx ON "public".menus_rels USING btree (path);
    CREATE INDEX IF NOT EXISTS menus_rels_posts_id_idx ON "public".menus_rels USING btree (posts_id);
    CREATE INDEX IF NOT EXISTS menus_rels_products_id_idx ON "public".menus_rels USING btree (products_id);
    CREATE INDEX IF NOT EXISTS menus_rels_taxonomy_terms_id_idx ON "public".menus_rels USING btree (taxonomy_terms_id);
    CREATE INDEX IF NOT EXISTS menus_site_idx ON "public".menus USING btree (site_id);
    CREATE INDEX IF NOT EXISTS menus_slug_idx ON "public".menus USING btree (slug);
    CREATE INDEX IF NOT EXISTS menus_source_source_source_id_idx ON "public".menus USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS menus_source_source_system_idx ON "public".menus USING btree (source_system);
    CREATE INDEX IF NOT EXISTS menus_updated_at_idx ON "public".menus USING btree (updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS comments_pkey ON "public".comments USING btree (id);
    CREATE UNIQUE INDEX IF NOT EXISTS comments_locales_pkey ON "public".comments_locales USING btree (id);
    CREATE UNIQUE INDEX IF NOT EXISTS menus_pkey ON "public".menus USING btree (id);
    CREATE UNIQUE INDEX IF NOT EXISTS menus_items_pkey ON "public".menus_items USING btree (id);
    CREATE UNIQUE INDEX IF NOT EXISTS menus_items_locales_pkey ON "public".menus_items_locales USING btree (id);
    CREATE UNIQUE INDEX IF NOT EXISTS menus_locales_pkey ON "public".menus_locales USING btree (id);
    CREATE UNIQUE INDEX IF NOT EXISTS menus_rels_pkey ON "public".menus_rels USING btree (id);
    DO $$ BEGIN
          alter table "public"."comments" add constraint "comments_pkey" PRIMARY KEY using index "comments_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."comments_locales" add constraint "comments_locales_pkey" PRIMARY KEY using index "comments_locales_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."menus" add constraint "menus_pkey" PRIMARY KEY using index "menus_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."menus_items" add constraint "menus_items_pkey" PRIMARY KEY using index "menus_items_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."menus_items_locales" add constraint "menus_items_locales_pkey" PRIMARY KEY using index "menus_items_locales_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."menus_locales" add constraint "menus_locales_pkey" PRIMARY KEY using index "menus_locales_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."menus_rels" add constraint "menus_rels_pkey" PRIMARY KEY using index "menus_rels_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."comments" add constraint "comments_author_customer_id_customers_id_fk" FOREIGN KEY (author_customer_id) REFERENCES "public"."customers"(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."comments" validate constraint "comments_author_customer_id_customers_id_fk";
    DO $$ BEGIN
          alter table "public"."comments" add constraint "comments_author_user_id_users_id_fk" FOREIGN KEY (author_user_id) REFERENCES "public"."users"(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."comments" validate constraint "comments_author_user_id_users_id_fk";
    DO $$ BEGIN
          alter table "public"."comments_locales" add constraint "comments_locales_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES "public"."comments"(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."comments_locales" validate constraint "comments_locales_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."comments" add constraint "comments_parent_id_comments_id_fk" FOREIGN KEY (parent_id) REFERENCES "public"."comments"(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."comments" validate constraint "comments_parent_id_comments_id_fk";
    DO $$ BEGIN
          alter table "public"."comments" add constraint "comments_site_id_sites_id_fk" FOREIGN KEY (site_id) REFERENCES "public"."sites"(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."comments" validate constraint "comments_site_id_sites_id_fk";
    DO $$ BEGIN
          alter table "public"."comments" add constraint "comments_target_entry_id_content_entries_id_fk" FOREIGN KEY (target_entry_id) REFERENCES "public"."content_entries"(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."comments" validate constraint "comments_target_entry_id_content_entries_id_fk";
    DO $$ BEGIN
          alter table "public"."comments" add constraint "comments_target_page_id_pages_id_fk" FOREIGN KEY (target_page_id) REFERENCES "public"."pages"(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."comments" validate constraint "comments_target_page_id_pages_id_fk";
    DO $$ BEGIN
          alter table "public"."comments" add constraint "comments_target_post_id_posts_id_fk" FOREIGN KEY (target_post_id) REFERENCES "public"."posts"(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."comments" validate constraint "comments_target_post_id_posts_id_fk";
    DO $$ BEGIN
          alter table "public"."comments" add constraint "comments_target_product_id_products_id_fk" FOREIGN KEY (target_product_id) REFERENCES "public"."products"(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."comments" validate constraint "comments_target_product_id_products_id_fk";
    DO $$ BEGIN
          alter table "public"."menus_items_locales" add constraint "menus_items_locales_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES "public"."menus_items"(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."menus_items_locales" validate constraint "menus_items_locales_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."menus_items" add constraint "menus_items_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES "public"."menus"(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."menus_items" validate constraint "menus_items_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."menus_locales" add constraint "menus_locales_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES "public"."menus"(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."menus_locales" validate constraint "menus_locales_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."menus_rels" add constraint "menus_rels_categories_fk" FOREIGN KEY (categories_id) REFERENCES "public"."categories"(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."menus_rels" validate constraint "menus_rels_categories_fk";
    DO $$ BEGIN
          alter table "public"."menus_rels" add constraint "menus_rels_content_entries_fk" FOREIGN KEY (content_entries_id) REFERENCES "public"."content_entries"(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."menus_rels" validate constraint "menus_rels_content_entries_fk";
    DO $$ BEGIN
          alter table "public"."menus_rels" add constraint "menus_rels_media_fk" FOREIGN KEY (media_id) REFERENCES "public"."media"(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."menus_rels" validate constraint "menus_rels_media_fk";
    DO $$ BEGIN
          alter table "public"."menus_rels" add constraint "menus_rels_pages_fk" FOREIGN KEY (pages_id) REFERENCES "public"."pages"(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."menus_rels" validate constraint "menus_rels_pages_fk";
    DO $$ BEGIN
          alter table "public"."menus_rels" add constraint "menus_rels_parent_fk" FOREIGN KEY (parent_id) REFERENCES "public"."menus"(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."menus_rels" validate constraint "menus_rels_parent_fk";
    DO $$ BEGIN
          alter table "public"."menus_rels" add constraint "menus_rels_posts_fk" FOREIGN KEY (posts_id) REFERENCES "public"."posts"(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."menus_rels" validate constraint "menus_rels_posts_fk";
    DO $$ BEGIN
          alter table "public"."menus_rels" add constraint "menus_rels_products_fk" FOREIGN KEY (products_id) REFERENCES "public"."products"(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."menus_rels" validate constraint "menus_rels_products_fk";
    DO $$ BEGIN
          alter table "public"."menus_rels" add constraint "menus_rels_taxonomy_terms_fk" FOREIGN KEY (taxonomy_terms_id) REFERENCES "public"."taxonomy_terms"(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."menus_rels" validate constraint "menus_rels_taxonomy_terms_fk";
    DO $$ BEGIN
          alter table "public"."menus" add constraint "menus_site_id_sites_id_fk" FOREIGN KEY (site_id) REFERENCES "public"."sites"(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."menus" validate constraint "menus_site_id_sites_id_fk";
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS "public"."menus_rels" CASCADE;
    DROP TABLE IF EXISTS "public"."menus_items_locales" CASCADE;
    DROP TABLE IF EXISTS "public"."menus_items" CASCADE;
    DROP TABLE IF EXISTS "public"."menus_locales" CASCADE;
    DROP TABLE IF EXISTS "public"."comments_locales" CASCADE;
    DROP TABLE IF EXISTS "public"."menus" CASCADE;
    DROP TABLE IF EXISTS "public"."comments" CASCADE;
    DROP SEQUENCE IF EXISTS "public"."comments_locales_id_seq";
    DROP SEQUENCE IF EXISTS "public"."menus_items_locales_id_seq";
    DROP SEQUENCE IF EXISTS "public"."menus_locales_id_seq";
    DROP SEQUENCE IF EXISTS "public"."menus_rels_id_seq";
    DROP TYPE IF EXISTS "public"."enum_menus_source_system";
    DROP TYPE IF EXISTS "public"."enum_menus_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum_menus_items_type";
    DROP TYPE IF EXISTS "public"."enum_menus_items_status";
    DROP TYPE IF EXISTS "public"."enum_comments_target_collection";
    DROP TYPE IF EXISTS "public"."enum_comments_status";
    DROP TYPE IF EXISTS "public"."enum_comments_source_system";
    DROP TYPE IF EXISTS "public"."enum_comments_source_mapping_status";
  `)
}

