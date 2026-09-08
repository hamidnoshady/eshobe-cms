declare global {
  namespace NodeJS {
    interface ProcessEnv {
      PAYLOAD_SECRET: string
      DATABASE_URL: string
      NEXT_PUBLIC_SERVER_URL: string
      VERCEL_PROJECT_PRODUCTION_URL: string
      CRON_SECRET: string
      PREVIEW_SECRET: string
      /** Absolute upload dir in production (volume mount); unset in dev. */
      MEDIA_DIR?: string
      /**
       * Optional dedicated key that seals the ArvanCloud object-storage secret key at
       * rest. The connection itself (endpoint, bucket, region, access key, encrypted
       * secret key) is configured by a superadmin in the `storage-connections`
       * collection — never through environment variables. When unset, PAYLOAD_SECRET
       * is used; rotating either requires re-entering the secret key.
       */
      OBJECT_STORAGE_KEY?: string
      /**
       * `'true'` runs the jobs cron in this container, `'false'` never does; unset
       * means "in production only". Must be `'false'` on more than one web replica.
       */
      JOBS_AUTORUN?: string
      /** Set by Next during `next build`; the env guard uses it to stand down. */
      NEXT_PHASE?: string
    }
  }
}

// If this file has no import/export statements (i.e. is a script)
// convert it into a module by adding an empty export statement.
export {}
