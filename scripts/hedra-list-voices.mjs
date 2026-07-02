#!/usr/bin/env node
/**
 * Polish-21 operator utility: fetch and print Hedra's voice library
 * so the operator can curate the 5-8 voices that populate
 * HEDRA_VOICE_ROSTER in packages/shared/src/video-models.ts.
 *
 * Usage:
 *   HEDRA_API_KEY=<your-key> node scripts/hedra-list-voices.mjs
 *
 * Or pass --key inline:
 *   node scripts/hedra-list-voices.mjs --key <your-key>
 *
 * The script hits GET https://api.hedra.com/web-app/public/voices,
 * flattens the label metadata (gender / accent / age), and prints
 * one line per voice suitable for copy-paste into video-models.ts.
 *
 * Zero-dep — plain Node built-ins (fetch is native on Node 20+).
 */

const BASE_URL = 'https://api.hedra.com/web-app/public';

function parseArgs(argv) {
  const args = { key: process.env.HEDRA_API_KEY ?? '' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--key' && argv[i + 1]) {
      args.key = argv[i + 1];
      i++;
    }
  }
  return args;
}

function labelOf(voice, name) {
  const labels = voice.asset?.labels ?? [];
  const hit = labels.find((l) => l?.name === name);
  return hit?.value ?? '(unknown)';
}

async function main() {
  const { key } = parseArgs(process.argv);
  if (!key) {
    console.error(
      'Missing Hedra API key. Set HEDRA_API_KEY or pass --key <token>.\n' +
        'Generate one at https://www.hedra.com/api-profile.',
    );
    process.exitCode = 1;
    return;
  }

  const res = await fetch(`${BASE_URL}/voices`, {
    method: 'GET',
    headers: { 'x-api-key': key },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Hedra /voices failed: HTTP ${res.status}\n${text.slice(0, 2000)}`);
    process.exitCode = 1;
    return;
  }

  const voices = await res.json();
  if (!Array.isArray(voices)) {
    console.error('Unexpected response shape (not an array):');
    console.error(JSON.stringify(voices, null, 2).slice(0, 2000));
    process.exitCode = 1;
    return;
  }

  console.log(`Hedra voice library — ${voices.length} voices\n`);
  console.log(
    ['ID'.padEnd(40), 'Name'.padEnd(24), 'Gender'.padEnd(10), 'Accent'.padEnd(16), 'Age'].join(' '),
  );
  console.log('-'.repeat(110));
  for (const v of voices) {
    console.log(
      [
        String(v.id).padEnd(40),
        String(v.name ?? '(unnamed)').padEnd(24),
        labelOf(v, 'gender').padEnd(10),
        labelOf(v, 'accent').padEnd(16),
        labelOf(v, 'age'),
      ].join(' '),
    );
  }

  console.log(
    '\nNext step: pick 5-8 well-matched voices (varied gender + age + accent) and paste',
  );
  console.log(
    'their IDs into HEDRA_VOICE_ROSTER in packages/shared/src/video-models.ts. Replace',
  );
  console.log('the PLACEHOLDER-* entries.\n');
}

main().catch((err) => {
  console.error('Unexpected failure:', err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
