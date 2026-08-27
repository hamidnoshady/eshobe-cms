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
       * Cloudflare R2. All four or none — `r2Configured()` treats a partial set as
       * "not configured" and keeps uploads on local disk, because a half-configured
       * bucket takes over the media collection and then fails on every upload.
       */
      R2_ACCESS_KEY_ID?: string
      R2_ACCOUNT_ID?: string
      R2_BUCKET?: string
      R2_SECRET_ACCESS_KEY?: string
      /** Overrides the derived `https://<account>.r2.cloudflarestorage.com`. */
      R2_ENDPOINT?: string
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
