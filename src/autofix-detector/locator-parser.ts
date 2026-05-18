/**
 * Locator parser — extracts the failing locator from a Playwright error
 * message. Deterministic regex over surface text; no LLM, no semantic
 * understanding required.
 *
 * Returns `ParsedLocator` with `confidence < 1.0` when the parser had to
 * fall back to a less specific matcher. Returns `null` only when no
 * locator-shaped substring is found at all.
 */

import type { LocatorExpressionKind, ParsedLocator } from './types.js';

interface PatternMatcher {
  kind:       LocatorExpressionKind;
  regex:      RegExp;
  confidence: number;
  build:      (match: RegExpMatchArray) => Omit<ParsedLocator, 'raw' | 'confidence'>;
}

const PATTERNS: readonly PatternMatcher[] = [
  // getByTestId('value')
  {
    kind: 'getByTestId',
    regex: /getByTestId\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/,
    confidence: 0.95,
    build: (m) => ({
      kind:          'getByTestId',
      testAttribute: 'data-testid',
      value:         m[2] ?? '',
      cssSelector:   `[data-testid="${m[2] ?? ''}"]`,
    }),
  },

  // getByRole('role', { name: 'Name' })
  {
    kind: 'getByRole',
    regex: /getByRole\(\s*(['"`])([^'"`]+)\1(?:\s*,\s*\{\s*name\s*:\s*(['"`])([^'"`]+)\3\s*\})?\s*\)/,
    confidence: 0.95,
    build: (m) => ({
      kind:  'getByRole',
      value: m[4] ? `${m[2]}:${m[4]}` : m[2]!,
    }),
  },

  // getByText('value')
  {
    kind: 'getByText',
    regex: /getByText\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/,
    confidence: 0.90,
    build: (m) => ({ kind: 'getByText', value: m[2] }),
  },

  // getByLabel('value')
  {
    kind: 'getByLabel',
    regex: /getByLabel\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/,
    confidence: 0.90,
    build: (m) => ({ kind: 'getByLabel', value: m[2] }),
  },

  // getByPlaceholder('value')
  {
    kind: 'getByPlaceholder',
    regex: /getByPlaceholder\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/,
    confidence: 0.90,
    build: (m) => ({ kind: 'getByPlaceholder', value: m[2] }),
  },

  // [data-test="x"] / [data-testid=x] — also matches loose whitespace
  {
    kind: 'attribute_selector',
    regex: /\[\s*(data-[a-z0-9_-]+)\s*=\s*(['"]?)([^'"\]]+)\2\s*\]/i,
    confidence: 0.85,
    build: (m) => ({
      kind:          'attribute_selector',
      testAttribute: m[1]!.toLowerCase(),
      value:         m[3],
      cssSelector:   m[0],
    }),
  },

  // locator('#id')
  {
    kind: 'css_selector',
    regex: /locator\(\s*(['"`])(#[a-zA-Z][\w-]*)\1\s*\)/,
    confidence: 0.80,
    build: (m) => ({
      kind:        'css_selector',
      value:       m[2],
      cssSelector: m[2],
    }),
  },

  // locator('.class') and combinator forms starting with .
  {
    kind: 'css_selector',
    regex: /locator\(\s*(['"`])(\.[\w-][\w\s.>+~\[\]"'=#-]*)\1\s*\)/,
    confidence: 0.75,
    build: (m) => ({
      kind:        'css_selector',
      value:       m[2],
      cssSelector: m[2],
    }),
  },

  // locator('input[type=password]') — tag + attr forms
  {
    kind: 'css_selector',
    regex: /locator\(\s*(['"`])([a-zA-Z][a-zA-Z0-9]*\s*\[[^'"]*\])\1\s*\)/,
    confidence: 0.75,
    build: (m) => ({
      kind:        'css_selector',
      value:       m[2],
      cssSelector: m[2],
    }),
  },

  // locator('any selector') — generic catch-all fallback
  {
    kind: 'css_selector',
    regex: /locator\(\s*(['"`])((?:\\.|(?!\1)[^\\])+)\1\s*\)/,
    confidence: 0.55,
    build: (m) => ({
      kind:        'css_selector',
      value:       m[2],
      cssSelector: m[2],
    }),
  },
];

/**
 * Parse the failing locator from a Playwright error message. Returns null
 * only when no locator-shaped substring is found.
 */
export function parseFailingLocator(errorMessage: string): ParsedLocator | null {
  if (!errorMessage || typeof errorMessage !== 'string') return null;

  for (const pattern of PATTERNS) {
    const match = errorMessage.match(pattern.regex);
    if (!match) continue;
    return {
      raw:        match[0],
      confidence: pattern.confidence,
      ...pattern.build(match),
    };
  }

  return null;
}

/**
 * Parse a raw selector expression (e.g. `getByTestId('product-list')` or
 * `[data-test="x"]`). Tries the input verbatim first so already-formed
 * `getBy*` expressions match; falls back to wrapping as a synthetic
 * `locator()` call for bare CSS selectors.
 */
export function parseLocatorExpression(raw: string): ParsedLocator | null {
  const normalized = raw.trim();
  if (!normalized) return null;

  const direct = parseFailingLocator(normalized);
  if (direct) return { ...direct, raw: normalized };

  const wrapped = parseFailingLocator(
    `locator('${normalized.replace(/'/g, "\\'")}')`,
  );
  if (wrapped) return { ...wrapped, raw: normalized };

  return null;
}
