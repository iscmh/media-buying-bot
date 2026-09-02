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
      case '--diagnose':
        args.diagnose = true;
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

async function diagnoseGoogleFlow({ token, cookieFile }) {
  const raw = readFileSync(cookieFile, 'utf8').trim();
  const arr = normalizeCookiesToArray(raw);
  console.log(
    `Diagnose: trying every plausible cookies-field shape against POST /google-flow/accounts`,
  );
  console.log(`(${arr.length} cookies parsed from ${cookieFile})\n`);

  // Build every plausible shape and try each one.
  const headerStr = arr.map((c) => `${c.name}=${c.value}`).join('; ');
  const netscape =
    '# Netscape HTTP Cookie File\n' +
    arr
      .map(
        (c) =>
          [
            c.domain || '.labs.google',
            c.hostOnly ? 'FALSE' : 'TRUE',
            c.path || '/',
            c.secure ? 'TRUE' : 'FALSE',
            String(Math.floor(c.expirationDate || Date.now() / 1000 + 86400 * 30)),
            c.name,
            c.value,
          ].join('\t'),
      )
      .join('\n') +
    '\n';
  const jsonArrayString = JSON.stringify(arr);
  const rawFileContent = raw;

  const shapes = [
    { name: 'A. cookies: <JSON array string>', body: { cookies: jsonArrayString } },
    { name: 'B. cookies: <raw file content>', body: { cookies: rawFileContent } },
    { name: 'C. cookies: <Cookie header string>', body: { cookies: headerStr } },
    { name: 'D. cookies: <Netscape file text>', body: { cookies: netscape } },
    { name: 'E. cookies: <JSON array actual>', body: { cookies: arr } },
    { name: 'F. cookie (singular): <JSON array string>', body: { cookie: jsonArrayString } },
    { name: 'G. cookie (singular): <Cookie header>', body: { cookie: headerStr } },
  ];

  for (const s of shapes) {
    const { status, body } = await callUseapi({
      method: 'POST',
      path: `/google-flow/accounts`,
      token,
      body: s.body,
    });
    const msg =
      typeof body === 'object' && body && 'error' in body
        ? `HTTP ${status} · ${body.error}`
        : `HTTP ${status} · ${JSON.stringify(body).slice(0, 200)}`;
    console.log(`  ${s.name}\n    → ${msg}\n`);
  }
  process.exit(0);
}

async function registerGoogleFlow({ token, cookieFile, label }) {
  if (!cookieFile) {
    console.error('Google Flow registration requires --cookie-file');
    printUsageAndExit(2);
  }
  const raw = readFileSync(cookieFile, 'utf8');
  if (!raw.trim()) {
    console.error(`Cookie file is empty: ${cookieFile}`);
    process.exit(2);
  }
  // If the file is already Netscape (starts with '# Netscape'), send it
  // through verbatim. Extensions like 'Get cookies.txt LOCALLY' produce
  // exactly this format and preserve HttpOnly/scoped cookies (LSID etc.)
  // that Cookie-Editor sometimes misses.
  let netscape;
  let debugNames;
  if (raw.trimStart().toLowerCase().startsWith('# netscape')) {
    netscape = raw.endsWith('\n') ? raw : raw + '\n';
    debugNames = raw
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('\t')[5])
      .filter(Boolean);
    console.log(
      `Registering Google Flow account with Netscape cookies.txt passthrough from ${cookieFile} (${raw.length} bytes, ${debugNames.length} cookies: ${debugNames.join(', ')})…`,
    );
  } else {
    const cookiesArray = normalizeCookiesToArray(raw.trim());
    if (cookiesArray.length === 0) {
      console.error(
        `Parsed 0 cookies from ${cookieFile}. Expected either:\n` +
          `  - A Netscape cookies.txt file (starts with '# Netscape'), from 'Get cookies.txt LOCALLY' extension, or\n` +
          `  - A Cookie-Editor JSON export (starts with '['), or\n` +
          `  - A DevTools 'Storage → Cookies' table paste (tab-separated rows), or\n` +
          `  - A flat 'name=v; name2=v2' Cookie header string.`,
      );
      process.exit(2);
    }
    debugNames = cookiesArray.map((c) => c.name);
    console.log(
      `Registering Google Flow account with cookies from ${cookieFile} (${raw.length} raw → ${cookiesArray.length} cookie entries: ${debugNames.join(', ')})…`,
    );
    netscape = buildNetscapeFile(cookiesArray);
  }
  const { status, body } = await callUseapi({
    method: 'POST',
    path: `/google-flow/accounts`,
    token,
    body: {
      cookies: netscape,
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

  if (args.diagnose) {
    if (args.service !== 'google-flow') {
      console.error('--diagnose is only implemented for --service google-flow');
      process.exit(2);
    }
    if (!args.cookieFile) {
      console.error('--diagnose requires --cookie-file');
      process.exit(2);
    }
    await diagnoseGoogleFlow({ token: args.token, cookieFile: args.cookieFile });
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

/**
 * useapi.net's Google Flow expects `cookies` in the request body as an
 * ACTUAL JSON array (not a stringified one), Cookie-Editor style:
 *   [{ name, value, domain, path, secure, httpOnly, sameSite }, ...]
 *
 * Accepts three input flavors and always returns an array:
 *   1. JSON array already (from Cookie-Editor export)  — parsed & used
 *   2. DevTools 'Storage → Cookies' tab-separated table — parsed
 *   3. Flat 'a=b; c=d' Cookie header — parsed, domain defaults to
 *      '.labs.google'
 */
function normalizeCookiesToArray(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // Case 1 — already a JSON array from Cookie-Editor / EditThisCookie.
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through.
    }
  }

  // Case 2 — DevTools table paste: tab-separated rows.
  if (trimmed.includes('\t')) {
    const cookies = [];
    for (const rawLine of trimmed.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const parts = line.split('\t').map((p) => p.trim());
      if (parts.length < 2) continue;
      const [name, value, domain, path] = parts;
      if (!name || value == null) continue;
      if (name.toLowerCase() === 'name' && value.toLowerCase() === 'value') continue;
      cookies.push({
        domain: domain || '.labs.google',
        expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
        hostOnly: name.startsWith('__Host-'),
        httpOnly: true,
        name,
        path: path || '/',
        sameSite: 'lax',
        secure: name.startsWith('__Secure-') || name.startsWith('__Host-'),
        session: false,
        storeId: '0',
        value,
      });
    }
    return cookies;
  }

  // Case 3 — flat 'name=value; name2=value2' cookie header.
  const cookies = [];
  for (const pair of trimmed.split(/;\s*/)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    cookies.push({
      name,
      value,
      domain: '.labs.google',
      path: '/',
      secure: name.startsWith('__Secure-') || name.startsWith('__Host-'),
      httpOnly: true,
      sameSite: 'Lax',
    });
  }
  return cookies;
}

/**
 * Serialize an array of Cookie-Editor cookie objects to Netscape
 * cookies.txt format. useapi.net's Google Flow parser accepts this
 * shape (verified 2026-09-02 via --diagnose).
 *
 * Netscape line:
 *   <domain>  <includeSubdomains>  <path>  <secure>  <expiry>  <name>  <value>
 * All tabs, one cookie per line, plus a '# Netscape HTTP Cookie File'
 * header. Session cookies get an expiry ~30 days from now (Netscape
 * format has no session marker).
 */
function buildNetscapeFile(cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  const defaultExp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  for (const c of cookies) {
    const domain = c.domain || '.google.com';
    const includeSubdomains = c.hostOnly ? 'FALSE' : 'TRUE';
    const path = c.path || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = Math.floor(c.expirationDate || defaultExp);
    lines.push([domain, includeSubdomains, path, secure, expiry, c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
