import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Allow Next to compile workspace packages on the fly.
    externalDir: true,
    // Polish-6: prompt .md files are loaded at runtime via
    // fs.readFileSync in @mbb/ai-providers/src/prompt-loader.ts.
    // Without this, Vercel's output file tracing won't include
    // the .md files in the serverless function bundle and every
    // pipeline (Sora, Kling, Nano Banana) crashes on cold start.
    outputFileTracingIncludes: {
      '/api/inngest': ['../../packages/ai-providers/src/prompts/**/*'],
      '/api/webhooks/whop': ['../../packages/ai-providers/src/prompts/**/*'],
    },
  },
  transpilePackages: ['@mbb/shared', '@mbb/db', '@mbb/jobs', '@mbb/meta-api', '@mbb/ai-providers'],
  eslint: {
    ignoreDuringBuilds: false,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

const sentryEnabled = !!process.env.SENTRY_AUTH_TOKEN;

export default sentryEnabled
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      silent: true,
      widenClientFileUpload: true,
      hideSourceMaps: true,
      disableLogger: true,
    })
  : nextConfig;
