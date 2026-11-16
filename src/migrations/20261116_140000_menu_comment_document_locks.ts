import { type MigrateDownArgs, type MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// The original menus/comments migration did not update Payload's lock relations.
// Accept databases where the same columns and constraints were already repaired.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE public.payload_locked_documents_rels
      ADD COLUMN IF NOT EXISTS menus_id uuid,
      ADD COLUMN IF NOT EXISTS comments_id uuid;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.payload_locked_documents_rels'::regclass
          AND conname = 'payload_locked_documents_rels_menus_fk'
      ) THEN
        ALTER TABLE public.payload_locked_documents_rels
          ADD CONSTRAINT payload_locked_documents_rels_menus_fk
          FOREIGN KEY (menus_id) REFERENCES public.menus(id) ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.payload_locked_documents_rels'::regclass
          AND conname = 'payload_locked_documents_rels_comments_fk'
      ) THEN
        ALTER TABLE public.payload_locked_documents_rels
          ADD CONSTRAINT payload_locked_documents_rels_comments_fk
          FOREIGN KEY (comments_id) REFERENCES public.comments(id) ON DELETE CASCADE;
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS payload_locked_documents_rels_menus_id_idx
      ON public.payload_locked_documents_rels (menus_id);
    CREATE INDEX IF NOT EXISTS payload_locked_documents_rels_comments_id_idx
      ON public.payload_locked_documents_rels (comments_id);
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE public.payload_locked_documents_rels
      DROP COLUMN IF EXISTS menus_id,
      DROP COLUMN IF EXISTS comments_id;
  `)
}
