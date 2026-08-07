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
    // Polish-28.0.4 Commit 64.4 hotfix: @ffmpeg-installer/ffmpeg ships
    // a per-platform binary that Next.js's default file-tracing does
    // NOT follow through workspace CommonJS require() chains. Mark it
    // external so Next doesn't try to bundle the .so/.exe into JS,
    // then explicitly include the binary directory in the serverless
    // function bundle via outputFileTracingIncludes.
    //
    // Real Vercel Hobby constraint: 50MB uncompressed per function.
    // The linux-x64 ffmpeg binary is ~78MB, which BLOWS THIS LIMIT.
    // Consequence: this config only unblocks Polish-28 on Vercel Pro
    // (250MB limit). If the build fails on Hobby with a
    // "Serverless Function too large" error, the follow-up hotfix is
    // to pivot extract-source-audio.ts to Replicate ffmpeg (adds
    // REPLICATE as a 5th BYOK requirement — the pattern already
    // proven by replicate-audio-trim.ts + replicate-concat.ts).
    serverComponentsExternalPackages: [
      '@ffmpeg-installer/ffmpeg',
      '@ffmpeg-installer/linux-x64',
    ],
    outputFileTracingIncludes: {
      // Every serverless function (Inngest workers + /api routes)
      // gets the ffmpeg-installer directory. Only the Polish-28
      // worker actually calls spawn(ffmpeg), but pnpm's hoisting
      // means the binary might land in either apps/web/node_modules
      // or the workspace-root .pnpm store — the double-pattern
      // catches both layouts.
      '/**/*': [
        './node_modules/@ffmpeg-installer/**/*',
        './node_modules/.pnpm/@ffmpeg-installer+**/node_modules/@ffmpeg-installer/**/*',
        '../../node_modules/@ffmpeg-installer/**/*',
        '../../node_modules/.pnpm/@ffmpeg-installer+**/node_modules/@ffmpeg-installer/**/*',
      ],
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
