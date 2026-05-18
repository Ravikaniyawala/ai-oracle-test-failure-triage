/**
 * Path normalizer — converts raw Playwright stack-frame paths into
 * repo-relative form. Best-effort, deterministic, no LLM.
 *
 * Shapes handled:
 *   - Absolute paths:        /Users/me/repo/tests/foo.spec.ts
 *   - file:// URLs:          file:///Users/me/repo/tests/foo.spec.ts
 *   - Webpack-mapped paths:  webpack:///./src/Button.tsx
 *   - Bundled JS:            /assets/index-abc123.js  (no source map)
 *   - node_modules:          /Users/me/repo/node_modules/...
 *   - Source-mapped:         /repo/src/Button.tsx?sourceMap (Vite dev)
 */

import { isAbsolute, relative, sep, posix } from 'path';

export interface PathNormalizationResult {
  raw:         string;
  normalized:  string;
  isRepoLocal: boolean;
  isBundled:   boolean;
  isVendor:    boolean;
  isTransient: boolean;
}

const BUNDLED_PATH_PATTERNS: readonly RegExp[] = [
  /\/(?:assets|static|build|dist|out)\/[A-Za-z0-9_-]+[.-][a-f0-9]{6,}\.[a-z]+$/i,
  /[A-Za-z0-9_-]+\.[a-f0-9]{6,}\.[a-z]+$/i,
  /^webpack:\/\/\//,
  /webpack:\/\/[^\/]+\/\(webpack\)/,
];

const VENDOR_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)node_modules\//,
  /(?:^|\/)vendor\//,
];

const TRANSIENT_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.next\//,
  /(?:^|\/)\.turbo\//,
  /(?:^|\/)\.cache\//,
  /(?:^|\/)\.parcel-cache\//,
  /(?:^|\/)\.vite\//,
  /(?:^|\/)\.nyc_output\//,
];

/**
 * Strip file:// prefix, query strings, line:col suffixes, "at " markers,
 * and parenthesization commonly emitted by Node stack traces.
 */
function cleanPath(input: string): string {
  let s = input.trim();

  const parenMatch = s.match(/\((.+?)(?::\d+)?(?::\d+)?\)$/);
  if (parenMatch) s = parenMatch[1]!;

  s = s.replace(/^\s*at\s+(?:[\w.<>$]+\s*\()?/, '');
  s = s.replace(/\)$/, '');

  if (s.startsWith('file://'))       s = s.slice('file://'.length);
  if (s.startsWith('webpack:///'))   s = s.slice('webpack:///'.length);

  s = s.split('?')[0]!;
  s = s.split('#')[0]!;

  s = s.replace(/:\d+:\d+$/, '');
  s = s.replace(/:\d+$/, '');

  return s;
}

/**
 * Normalize a raw path against a repo root.
 *
 * Pattern detection runs against BOTH the raw input and the cleaned form
 * because `cleanPath` strips `webpack:///` (itself a bundling indicator).
 */
export function normalizePath(rawInput: string, repoRoot: string): PathNormalizationResult {
  if (!rawInput) {
    return {
      raw:         rawInput,
      normalized:  '',
      isRepoLocal: false,
      isBundled:   false,
      isVendor:    false,
      isTransient: false,
    };
  }

  const cleaned = cleanPath(rawInput);

  const isBundled =
    BUNDLED_PATH_PATTERNS.some(r => r.test(rawInput)) ||
    BUNDLED_PATH_PATTERNS.some(r => r.test(cleaned));
  const isVendor =
    VENDOR_PATH_PATTERNS.some(r => r.test(rawInput)) ||
    VENDOR_PATH_PATTERNS.some(r => r.test(cleaned));
  const isTransient =
    TRANSIENT_PATH_PATTERNS.some(r => r.test(rawInput)) ||
    TRANSIENT_PATH_PATTERNS.some(r => r.test(cleaned));

  let normalized = cleaned;
  let isRepoLocal = false;

  if (isAbsolute(cleaned) && repoRoot) {
    const rel = relative(repoRoot, cleaned);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      normalized  = rel.split(sep).join(posix.sep);
      isRepoLocal = true;
    }
  } else if (cleaned.startsWith('./') || cleaned.startsWith('../')) {
    normalized = cleaned.replace(/^\.\//, '');
    isRepoLocal = !cleaned.startsWith('../');
  } else if (cleaned && !cleaned.startsWith('/')) {
    normalized = cleaned;
    isRepoLocal = !isVendor && !isBundled && !isTransient;
  }

  return { raw: rawInput, normalized, isRepoLocal, isBundled, isVendor, isTransient };
}
