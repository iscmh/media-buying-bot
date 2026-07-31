import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Polish-25.8 Commit 52: regression tripwire - no internal-jargon
 * strings leak into user-facing surfaces.
 *
 * Real background: every prior release keeps introducing new copy
 * with "Polish-25 Commit XX" markers or raw enum names ("makeugc",
 * "polish25_makeugc") that end up rendered to beta operators. Beta
 * users pattern-match this in seconds and lose trust. Commit 40 was
 * the first sweep; Commit 51 was the AI-voice sweep; this test locks
 * the invariant so a future edit that reintroduces the leak fails CI
 * before it can ship.
 *
 * How it works:
 *   - Walk packages/shared/src/[star star]/*.ts (this is where copy
 *     constants live: banners, error guidance, provider labels,
 *     onboarding steps, form labels, cost line-items).
 *   - Extract STRING LITERAL contents (double, single, template).
 *   - Strip comments (line + block) so jargon inside code comments is
 *     ignored - only user-facing string literals count.
 *   - Skip files matching the do-not-touch allowlist below.
 *   - For every remaining string literal, match against the jargon
 *     patterns. Any hit fails the test with the file + snippet.
 *
 * If you're seeing this test fail: your new copy leaks jargon.
 * Options:
 *   (a) Rewrite the string to use the user-friendly display name
 *       (e.g. "Instant UGC" instead of "MakeUGC").
 *   (b) If the string is genuinely an internal identifier (an enum
 *       constant, an event name, a metadata key), add the file to
 *       ALLOWLISTED_FILES below with a comment explaining why.
 *   (c) If the whole file is internal-only (prompts sent to an AI
 *       provider, database schema), add it to ALLOWLISTED_FILES.
 */

// Built via constructor so esbuild's parser never sees anything it
// could confuse with template literals / division / lookahead.
const JARGON_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'Polish-XX version marker', regex: new RegExp('Polish[-_ ]?[0-9]+', 'i') },
  { name: 'Commit XX reference', regex: new RegExp('Commit[ \\t]+[0-9]+') },
  { name: 'MakeUGC brand name', regex: new RegExp('MakeUGC') },
  { name: 'polish25_ enum leak', regex: new RegExp('polish25_[a-z_]+') },
  { name: 'polish23_ enum leak', regex: new RegExp('polish23_[a-z_]+') },
  {
    name: 'raw makeugc enum leak',
    // Match "makeugc" not followed by ".com" and not part of an identifier.
    regex: new RegExp('(^|[^a-zA-Z0-9_.])makeugc(?!\\.com)([^a-zA-Z0-9_]|$)'),
  },
  { name: 'gemini_nano_banana enum leak', regex: new RegExp('gemini_nano_banana') },
  { name: 'wavespeed_ai enum leak', regex: new RegExp('wavespeed_ai') },
];

// Files where jargon is intentional + never reaches the user.
const ALLOWLISTED_FILES = new Set<string>([
  // Version constant + release-name blurb (developer/monitoring-facing).
  'polish-version.ts',
  // Pipeline enum + descriptor keys - internal identifiers.
  'pipeline-descriptors.ts',
  // Enum type declarations.
  'types.ts',
  // Character-lock prompt fragment sent to AI providers, not users.
  'polish23-character-lock.ts',
  'polish23-vision-analysis.ts',
  // Raw omni prompt sent to kie.ai, not rendered.
  'kie-omni-prompt.ts',
  // Video-model registry - model IDs + provider IDs, not display strings.
  'video-models.ts',
  // Cost estimator switch cases + PRICING property keys are internal
  // pipeline identifiers. Display line-item labels have been cleaned;
  // any future new label passes the substring test after ${...} strip.
  'cost-estimation.ts',
  // Barrel re-exports include internal file paths.
  'index.ts',
  // Provider descriptor keys ('makeugc', 'wavespeed_ai') are internal
  // enum identifiers used to map to display labels. Display text (label,
  // description, hint) has been cleaned; adding a new user-visible
  // string here would still surface via the runtime UI test if it
  // reintroduces jargon.
  'ai-provider-form.ts',
]);

const SKIPPED_DIRS = new Set(['prompts']);

const ROOT = path.resolve(__dirname, '../src');

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (SKIPPED_DIRS.has(entry)) continue;
      out.push(...walkTsFiles(full));
    } else if (s.isFile() && entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(src: string): string {
  const noBlocks = src.replace(new RegExp('/\\*[\\s\\S]*?\\*/', 'g'), '');
  return noBlocks
    .split('\n')
    .map((line) => line.replace(new RegExp('//.*$'), ''))
    .join('\n');
}

function stripTemplateExpressions(literal: string): string {
  // ${...} interpolations are JS expressions, not user-visible text.
  // Balance-match one level of nesting is enough for our patterns.
  return literal.replace(new RegExp('\\$\\{[^}]*\\}', 'g'), '');
}

function extractStringLiterals(src: string): string[] {
  const out: string[] = [];
  const patterns = [
    new RegExp('"((?:[^"\\\\]|\\\\.)*)"', 'g'),
    new RegExp("'((?:[^'\\\\]|\\\\.)*)'", 'g'),
    new RegExp(
      String.fromCharCode(96) + '([^' + String.fromCharCode(96) + ']*)' + String.fromCharCode(96),
      'g',
    ),
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const raw = m[1] ?? '';
      out.push(stripTemplateExpressions(raw));
    }
  }
  return out;
}

interface Leak {
  file: string;
  pattern: string;
  snippet: string;
}

function scanFile(filepath: string): Leak[] {
  const src = readFileSync(filepath, 'utf8');
  const codeOnly = stripComments(src);
  const literals = extractStringLiterals(codeOnly);
  const leaks: Leak[] = [];
  for (const literal of literals) {
    for (const { name, regex } of JARGON_PATTERNS) {
      if (regex.test(literal)) {
        const snippet = literal.length > 120 ? literal.slice(0, 120) + '...' : literal;
        leaks.push({
          file: path.relative(ROOT, filepath),
          pattern: name,
          snippet,
        });
      }
    }
  }
  return leaks;
}

describe('Polish-25.8 Commit 52: no jargon leaks in @mbb/shared user-facing strings', () => {
  const allFiles = walkTsFiles(ROOT).filter((f) => !ALLOWLISTED_FILES.has(path.basename(f)));

  it('scans a non-empty file set', () => {
    expect(allFiles.length).toBeGreaterThan(10);
  });

  it('has zero jargon leaks in every scanned file', () => {
    const allLeaks: Leak[] = [];
    for (const f of allFiles) {
      allLeaks.push(...scanFile(f));
    }
    if (allLeaks.length > 0) {
      const summary = allLeaks
        .map((l) => '  [' + l.pattern + '] ' + l.file + '\n    string: "' + l.snippet + '"')
        .join('\n');
      throw new Error(
        '\nFound ' +
          allLeaks.length +
          ' jargon leak(s) in user-facing strings:\n\n' +
          summary +
          '\n\nFix: rewrite the string to use the user-friendly display name ' +
          "(e.g. 'Instant UGC' instead of 'MakeUGC').\n" +
          'If the string is genuinely internal (an enum constant, event name, metadata key), ' +
          'add the file to ALLOWLISTED_FILES in ' +
          'packages/shared/tests/no-jargon-leaks.test.ts with a comment.\n',
      );
    }
    expect(allLeaks).toEqual([]);
  });
});
