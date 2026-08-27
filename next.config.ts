import { withPayload } from '@payloadcms/next/withPayload'
import type { NextConfig } from 'next'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(__filename)
import { redirects } from './redirects'

// NEXT_PUBLIC_SERVER_URL first: this value is inlined at BUILD time into the
// CSP `frame-ancestors` header and `images.remotePatterns`, so the production
// image build must receive it (see the Dockerfile's ARG) or live preview is
// framed from an origin the CSP does not allow.
const NEXT_PUBLIC_SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.__NEXT_PRIVATE_ORIGIN || 'http://localhost:3000')

const nextConfig: NextConfig = {
  // The production Dockerfile copies `.next/standalone` and runs `node server.js`;
  // without this the image build fails at that COPY step.
  output: 'standalone',
  // Temporarily required on Windows until Next.js fixes Turbopack Sass resolution.
  // See: https://github.com/vercel/next.js/issues/86431
  sassOptions: {
    loadPaths: ['./node_modules/@payloadcms/ui/dist/scss/'],
  },
  images: {
    localPatterns: [
      {
        pathname: '/api/media/file/**',
      },
    ],
    qualities: [100],
    remotePatterns: [
      ...[NEXT_PUBLIC_SERVER_URL /* 'https://example.com' */].map((item) => {
        const url = new URL(item)

        return {
          hostname: url.hostname,
          protocol: url.protocol.replace(':', '') as 'http' | 'https',
        }
      }),
    ],
  },
  /**
   * Live preview renders a customer domain inside an iframe on the admin origin —
   * a cross-origin frame, which browsers block by default. Without this the preview
   * pane is blank with only a console message, and the failure looks like a broken
   * URL rather than a policy.
   *
   * `frame-ancestors` and not `X-Frame-Options`: the latter has no origin list, only
   * `SAMEORIGIN`, which is exactly what this is not. Naming the admin origin rather
   * than allowing any parent is the whole point — a customer page must not be
   * frameable by a third party for clickjacking.
   */
  async headers() {
    return [
      {
        headers: [
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors 'self' ${NEXT_PUBLIC_SERVER_URL}`,
          },
        ],
        // Payload's admin sets its own headers; this is for the rendered sites.
        source: '/((?!admin|api).*)',
      },
    ]
  },
  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    }

    return webpackConfig
  },
  reactStrictMode: true,
  redirects,
  turbopack: {
    root: path.resolve(dirname),
  },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
