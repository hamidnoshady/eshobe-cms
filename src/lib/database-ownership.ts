/**
 * Post-migration ownership normalisation for the srv1 split-role model.
 *
 * The production database runs the **owner-only** model: every object in
 * schema `public` is owned by the restricted runtime role (`eshobe_app`),
 * `relacl` is NULL (owner-only access) and `pg_default_acl` is empty — there
 * are no explicit grants anywhere. The one-shot migrator connects as the
 * privileged role instead, so without this step everything it creates
 * (tables, sequences, indexes, enums) is owned by the privileged role and the
 * runtime role cannot even SELECT it. GRANTs are deliberately NOT used to
 * bridge that gap: that would create a second, half-adopted permission model
 * next to the existing owner-only one. Ownership is transferred instead,
 * which also keeps the schema exactly as the live database already looks.
 */

type Env = Record<string, string | undefined>

/** Structural types only — no import of `pg`, which is not a direct dependency. */
interface QueryResultLike<R> {
  rows: R[]
  rowCount: number | null
}
interface SqlExecutor {
  query: <R>(sql: string, values?: unknown[]) => Promise<QueryResultLike<R>>
}
interface OwnershipClient extends SqlExecutor {
  release: () => void
}
export interface OwnershipPool extends SqlExecutor {
  connect: () => Promise<OwnershipClient>
}

export interface OwnershipChanges {
  tables: number
  sequences: number
  views: number
  types: number
}

export interface OwnershipViolation {
  kind: string
  name: string
  problem: string
}

const PUBLIC = 'public'

// Types the migrator may create in `public`: enums, domains, ranges and
// multiranges have no relation; standalone composites point at a pg_class row
// of relkind 'c'. Table row types (relkind r/p/v/m/f) and array types
// (typtype 'b') follow their owning table/type automatically on ALTER … OWNER
// and cannot be altered directly, so they are excluded everywhere.
const TYPE_FILTER = `n.nspname = '${PUBLIC}'
  AND t.typisdefined
  AND (t.typtype IN ('e', 'd', 'r', 'm') OR rc.relkind = 'c')`

// Objects installed by an extension cannot change owner independently of the
// extension, so they are excluded from reassignment (and from the ownership
// half of the gate). They remain subject to the accessibility checks.
const NOT_EXTENSION_RELATION = `NOT EXISTS (
    SELECT 1 FROM pg_depend d
    WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
  )`
const NOT_EXTENSION_TYPE = `NOT EXISTS (
    SELECT 1 FROM pg_depend d
    WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e'
  )`

const quotedName = (namespace: string, name: string) => `format('%I.%I', ${namespace}, ${name})`

/**
 * Which role owns the schema contents at runtime. Never guessed: an explicit
 * `APP_DATABASE_ROLE` wins, otherwise the username of `DATABASE_URL` when the
 * step is allowed to see it. The migration step gets neither a fallback nor a
 * hardcoded default — a wrong role name here would hand a whole schema to an
 * unrelated login.
 */
export const resolveRuntimeRole = (env: Env = process.env): string => {
  const explicit = env.APP_DATABASE_ROLE?.trim()
  if (explicit) return explicit

  const runtimeURL = env.DATABASE_URL?.trim()
  if (runtimeURL) {
    try {
      const url = new URL(runtimeURL)
      if (['postgres:', 'postgresql:'].includes(url.protocol) && url.username) {
        return decodeURIComponent(url.username)
      }
    } catch {
      // Fall through to the refusal below. Never echo the URL: it is a
      // credential, and malformed values are how credentials leak into logs.
    }
  }

  throw new Error(
    'Cannot determine the runtime database role that must own schema public. ' +
      'Set APP_DATABASE_ROLE (or expose DATABASE_URL so its username can be derived). ' +
      'Refusing to guess or hardcode a role name.',
  )
}

const assertRoleExists = async (executor: SqlExecutor, role: string): Promise<void> => {
  const found = await executor.query<{ ok: number }>(
    'SELECT 1 AS ok FROM pg_roles WHERE rolname = $1::text',
    [role],
  )
  if (!found.rowCount) {
    // Deliberately names the role (not a secret) but not any connection URL.
    throw new Error(`Runtime database role "${role}" does not exist on this server.`)
  }
}

/**
 * Reassign everything the migrations left owned by the privileged role to the
 * runtime role: tables, sequences, views (incl. materialised) and types in
 * schema `public`. Objects already owned by the runtime role are skipped, so a
 * re-run with nothing changed issues no DDL at all and takes no locks.
 * All statements run in one transaction; identifiers are quoted server-side.
 */
export const normalizePublicOwnership = async (
  pool: OwnershipPool,
  role: string,
): Promise<OwnershipChanges> => {
  await assertRoleExists(pool, role)

  const plan = await pool.query<{ kind: string; ddl: string; name: string }>(
    `
    SELECT kind, ddl, name FROM (
      SELECT 'table' AS kind, 1 AS rank,
             format('ALTER TABLE %I.%I OWNER TO %I', n.nspname, c.relname, $1::text) AS ddl,
             ${quotedName('n.nspname', 'c.relname')} AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${PUBLIC}' AND c.relkind IN ('r', 'p', 'f')
        AND pg_get_userbyid(c.relowner) <> $1::text
        AND ${NOT_EXTENSION_RELATION}
      UNION ALL
      SELECT 'sequence', 2,
             format('ALTER SEQUENCE %I.%I OWNER TO %I', n.nspname, c.relname, $1::text),
             ${quotedName('n.nspname', 'c.relname')}
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${PUBLIC}' AND c.relkind = 'S'
        AND pg_get_userbyid(c.relowner) <> $1::text
        AND ${NOT_EXTENSION_RELATION}
      UNION ALL
      SELECT 'view', 3,
             format('ALTER VIEW %I.%I OWNER TO %I', n.nspname, c.relname, $1::text),
             ${quotedName('n.nspname', 'c.relname')}
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${PUBLIC}' AND c.relkind = 'v'
        AND pg_get_userbyid(c.relowner) <> $1::text
        AND ${NOT_EXTENSION_RELATION}
      UNION ALL
      SELECT 'materialized view', 4,
             format('ALTER MATERIALIZED VIEW %I.%I OWNER TO %I', n.nspname, c.relname, $1::text),
             ${quotedName('n.nspname', 'c.relname')}
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${PUBLIC}' AND c.relkind = 'm'
        AND pg_get_userbyid(c.relowner) <> $1::text
        AND ${NOT_EXTENSION_RELATION}
      UNION ALL
      SELECT 'type', 5,
             format('ALTER %s %I.%I OWNER TO %I',
                    CASE WHEN t.typtype = 'd' THEN 'DOMAIN' ELSE 'TYPE' END,
                    n.nspname, t.typname, $1::text),
             ${quotedName('n.nspname', 't.typname')}
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_class rc ON rc.oid = t.typrelid
      WHERE ${TYPE_FILTER}
        AND pg_get_userbyid(t.typowner) <> $1::text
        AND ${NOT_EXTENSION_TYPE}
    ) plan
    ORDER BY rank, name
  `,
    [role],
  )

  const changes: OwnershipChanges = { tables: 0, sequences: 0, views: 0, types: 0 }
  if (plan.rows.length) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      try {
        for (const row of plan.rows) {
          await client.query(row.ddl)
          if (row.kind === 'table') changes.tables += 1
          else if (row.kind === 'sequence') changes.sequences += 1
          else if (row.kind === 'view' || row.kind === 'materialized view') changes.views += 1
          else changes.types += 1
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    } finally {
      client.release()
    }
  }

  return changes
}

/**
 * Verification gate, run after normalisation in the same one-shot command:
 * every object in schema `public` must be usable by the runtime role —
 * SELECT on tables/views, USAGE+SELECT on sequences, USAGE on types — and,
 * because the deployed model is owner-only, must actually be owned by it.
 * Any violation means `web` would start against objects it cannot touch, so
 * the caller must fail the migrate step (non-zero exit) on a non-empty list.
 */
export const findPublicOwnershipViolations = async (
  pool: OwnershipPool,
  role: string,
): Promise<OwnershipViolation[]> => {
  await assertRoleExists(pool, role)

  const violations = await pool.query<OwnershipViolation>(
    `
    SELECT kind, name, problem FROM (
      SELECT 'schema' AS kind, '${PUBLIC}' AS name,
             'runtime role lacks USAGE on the schema' AS problem
      WHERE NOT has_schema_privilege($1::text, '${PUBLIC}', 'USAGE')

      UNION ALL
      SELECT 'table', ${quotedName('n.nspname', 'c.relname')},
             'runtime role cannot SELECT'
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${PUBLIC}' AND c.relkind IN ('r', 'p', 'f')
        AND NOT has_table_privilege($1::text, ${quotedName('n.nspname', 'c.relname')}, 'SELECT')

      UNION ALL
      SELECT 'view', ${quotedName('n.nspname', 'c.relname')},
             'runtime role cannot SELECT'
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${PUBLIC}' AND c.relkind = 'v'
        AND NOT has_table_privilege($1::text, ${quotedName('n.nspname', 'c.relname')}, 'SELECT')

      UNION ALL
      SELECT 'materialized view', ${quotedName('n.nspname', 'c.relname')},
             'runtime role cannot SELECT'
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${PUBLIC}' AND c.relkind = 'm'
        AND NOT has_table_privilege($1::text, ${quotedName('n.nspname', 'c.relname')}, 'SELECT')

      UNION ALL
      SELECT 'sequence', ${quotedName('n.nspname', 'c.relname')},
             'runtime role lacks USAGE and/or SELECT'
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${PUBLIC}' AND c.relkind = 'S'
        AND NOT (has_sequence_privilege($1::text, ${quotedName('n.nspname', 'c.relname')}, 'USAGE')
             AND has_sequence_privilege($1::text, ${quotedName('n.nspname', 'c.relname')}, 'SELECT'))

      UNION ALL
      SELECT 'type', ${quotedName('n.nspname', 't.typname')},
             'runtime role lacks USAGE'
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_class rc ON rc.oid = t.typrelid
      WHERE ${TYPE_FILTER}
        AND NOT has_type_privilege($1::text, ${quotedName('n.nspname', 't.typname')}, 'USAGE')

      UNION ALL
      SELECT CASE WHEN c.relkind = 'S' THEN 'sequence'
                  WHEN c.relkind = 'v' THEN 'view'
                  WHEN c.relkind = 'm' THEN 'materialized view'
                  ELSE 'table' END,
             ${quotedName('n.nspname', 'c.relname')},
             'owned by ' || pg_get_userbyid(c.relowner) || ', expected ' || $1::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${PUBLIC}' AND c.relkind IN ('r', 'p', 'f', 'S', 'v', 'm')
        AND pg_get_userbyid(c.relowner) <> $1::text
        AND ${NOT_EXTENSION_RELATION}

      UNION ALL
      SELECT 'type', ${quotedName('n.nspname', 't.typname')},
             'owned by ' || pg_get_userbyid(t.typowner) || ', expected ' || $1::text
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_class rc ON rc.oid = t.typrelid
      WHERE ${TYPE_FILTER}
        AND pg_get_userbyid(t.typowner) <> $1::text
        AND ${NOT_EXTENSION_TYPE}
    ) violations
    ORDER BY kind, name
  `,
    [role],
  )

  return violations.rows
}

export const assertPublicOwnershipForRuntime = async (
  pool: OwnershipPool,
  role: string,
): Promise<void> => {
  const violations = await findPublicOwnershipViolations(pool, role)
  if (violations.length) {
    const shown = violations
      .slice(0, 10)
      .map((v) => `${v.kind} ${v.name}: ${v.problem}`)
      .join('; ')
    const more = violations.length > 10 ? ` (+${violations.length - 10} more)` : ''
    throw new Error(
      `Ownership gate failed: ${violations.length} object(s) in schema ${PUBLIC} are not ` +
        `owned by / accessible to runtime role "${role}" — ${shown}${more}. ` +
        'web must not start against this database.',
    )
  }
}
