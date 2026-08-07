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
    //
    // Polish-28.0.5 Commit 64.5: reverted 28.0.4's @ffmpeg-installer
    // bundling. The linux-x64 ffmpeg binary is ~78MB alone; Vercel
    // Hobby caps serverless functions at 50MB uncompressed. The 28.0.4
    // deploy silently failed post-build with a generic "unexpected
    // error" — /api/health never advanced past 28.0.3.
    //
    // Polish-28 audio + frame extraction now goes through Replicate
    // ffmpeg (packages/jobs/src/lib/extract-source-audio.ts +
    // extractFirstFramePng in the worker). REPLICATE is the 5th BYOK
    // required for Polish-28. Pattern predecessor:
    // packages/ai-providers/src/replicate-audio-trim.ts.
    //
    // @ffmpeg-installer/ffmpeg is kept as a packages/jobs dep for
    // local dev only (used by video-compress.ts's graceful-degrade
    // path — never invoked in production).
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
