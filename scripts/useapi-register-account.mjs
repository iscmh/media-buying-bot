#!/usr/bin/env node
/**
 * Polish-29.0.1 Commit 110.1 operator utility: register a Google Flow
 * or Dreamina account against our shared useapi.net bearer token. Run
 * once per account, from the terminal.
 *
 * Usage:
 *   USEAPI_NET_API_TOKEN=<token> node scripts/useapi-register-account.mjs \
 *     --service dreamina --email you@example.com --password 'pw' --region us
 *
 *   USEAPI_NET_API_TOKEN=<token> node scripts/useapi-register-account.mjs \
 *     --service google-flow --cookie-file ./cookies.txt
 *
 * Flags:
 *   --service        google-flow | dreamina                     (required)
 *   --label          human-readable label, e.g. "gflow-primary"  (optional)
 *   --token          override USEAPI_NET_API_TOKEN env var       (optional)
 *
 * Dreamina-only:
 *   --email          Dreamina account email                      (required)
 *   --password       Dreamina account password                   (required)
 *   --region         us | ca                                     (required)
 *
 * Google-Flow-only:
 *   --cookie-file    path to a text file containing the raw Cookie
 *                    header string copied from DevTools           (required)
 *
 * List already-registered accounts instead of adding one:
 *   node scripts/useapi-register-account.mjs --service dreamina --list
 *
 * Zero-dep — plain Node built-ins (fetch native on Node 20+).
 */

import { readFileSync } from 'node:fs';

const USEAPI_BASE = 'https://api.useapi.net/v1';

function parseArgs(argv) {
  const args = {
    service: '',
    label: '',
    token: process.env.USEAPI_NET_API_TOKEN ?? '',
    email: '',
    password: '',
    region: '',
    cookieFile: '',
    list: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--service':
        args.service = next;
        i++;
        break;
      case '--label':
        args.label = next;
        i++;
        break;
      case '--token':
        args.token = next;
        i++;
        break;
      case '--email':
        args.email = next;
        i++;
        break;
      case '--password':
        args.password = next;
        i++;
        break;
      case '--region':
        args.region = next;
        i++;
        break;
      case '--cookie-file':
        args.cookieFile = next;
        i++;
        break;
      case '--list':
        args.list = true;
        break;
      case '-h':
      case '--help':
        printUsageAndExit(0);
        break;
      default:
        console.error(`Unknown flag: ${flag}`);
        printUsageAndExit(2);
    }
  }
  return args;
}

function printUsageAndExit(code) {
  console.error(
    `Usage:\n` +
      `  USEAPI_NET_API_TOKEN=<token> node scripts/useapi-register-account.mjs \\\n` +
      `    --service dreamina --email you@example.com --password 'pw' --region us\n\n` +
      `  USEAPI_NET_API_TOKEN=<token> node scripts/useapi-register-account.mjs \\\n` +
      `    --service google-flow --cookie-file ./cookies.txt\n\n` +
      `  node scripts/useapi-register-account.mjs --service dreamina --list\n`,
  );
  process.exit(code);
}

async function callUseapi({ method, path, token, body }) {
  const url = `${USEAPI_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { _non_json_body: text.slice(0, 2000) };
  }
  return { status: res.status, body: parsed };
}

async function listAccounts({ service, token }) {
  const { status, body } = await callUseapi({
    method: 'GET',
    path: `/${service}/accounts`,
    token,
  });
  console.log(`GET /${service}/accounts → HTTP ${status}`);
  console.log(JSON.stringify(body, null, 2));
  process.exit(status >= 200 && status < 300 ? 0 : 1);
}

async function registerDreamina({ token, email, password, region, label }) {
  if (!email || !password || !region) {
    console.error('Dreamina registration requires --email, --password, --region');
    printUsageAndExit(2);
  }
  if (region !== 'us' && region !== 'ca') {
    console.error(`--region must be 'us' or 'ca' (got ${region})`);
    process.exit(2);
  }
  console.log(`Registering Dreamina account: ${email} (region=${region})…`);
  const { status, body } = await callUseapi({
    method: 'POST',
    path: `/dreamina/accounts`,
    token,
    body: {
      email,
      password,
      region,
      ...(label ? { label } : {}),
    },
  });
  console.log(`POST /dreamina/accounts → HTTP ${status}`);
  console.log(JSON.stringify(body, null, 2));
  process.exit(status >= 200 && status < 300 ? 0 : 1);
}

async function registerGoogleFlow({ token, cookieFile, label }) {
  if (!cookieFile) {
    console.error('Google Flow registration requires --cookie-file');
    printUsageAndExit(2);
  }
  const cookie = readFileSync(cookieFile, 'utf8').trim();
  if (!cookie) {
    console.error(`Cookie file is empty: ${cookieFile}`);
    process.exit(2);
  }
  console.log(
    `Registering Google Flow account with cookies from ${cookieFile} (${cookie.length} chars)…`,
  );
  const { status, body } = await callUseapi({
    method: 'POST',
    path: `/google-flow/accounts`,
    token,
    body: {
      cookie,
      ...(label ? { label } : {}),
    },
  });
  console.log(`POST /google-flow/accounts → HTTP ${status}`);
  console.log(JSON.stringify(body, null, 2));
  process.exit(status >= 200 && status < 300 ? 0 : 1);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.token) {
    console.error('USEAPI_NET_API_TOKEN is not set (or pass --token).');
    process.exit(2);
  }
  if (!args.service) {
    console.error('--service is required (google-flow | dreamina)');
    printUsageAndExit(2);
  }
  if (args.service !== 'google-flow' && args.service !== 'dreamina') {
    console.error(`--service must be 'google-flow' or 'dreamina' (got ${args.service})`);
    process.exit(2);
  }

  if (args.list) {
    await listAccounts({ service: args.service, token: args.token });
    return;
  }

  if (args.service === 'dreamina') {
    await registerDreamina({
      token: args.token,
      email: args.email,
      password: args.password,
      region: args.region,
      label: args.label,
    });
    return;
  }
  await registerGoogleFlow({
    token: args.token,
    cookieFile: args.cookieFile,
    label: args.label,
  });
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
