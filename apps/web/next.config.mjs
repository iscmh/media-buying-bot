import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Allow Next to compile workspace packages on the fly.
    externalDir: true,
    // Polish-9.5: outputFileTracingIncludes for prompt .md files was
    // dropped. Polish-6 tried to ship the .md files into the serverless
    // bundle via tracing but it never resolved at runtime — every
    // Kling/Sora/Nano-Banana run crashed with "Could not locate prompts
    // directory". Replaced by build-time bundling in
    // @mbb/ai-providers/scripts/build-prompts.mjs which embeds the
    // prompt text into the JS bundle. No file-tracing required.
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
