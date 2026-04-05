import { type PrContext, type PrRelevance } from './types.js';

// Generic tokens too short or too common to be meaningful test/file identifiers.
const SKIP_TOKENS = new Set([
  'test', 'spec', 'src',  'lib', 'app',  'util', 'utils',
  'index', 'main', 'base', 'common', 'shared', 'helper', 'helpers',
  'page', 'pages', 'component', 'components', 'module', 'modules',
  'the', 'and', 'for', 'with',
]);

/**
 * Split a test name or file path into meaningful keyword tokens.
 *
 * - Splits on slash, hyphen, underscore, dot, and space
 * - Lowercases all tokens
 * - Filters out tokens shorter than 4 characters
 * - Filters out generic stop words defined in SKIP_TOKENS
 */
function tokenise(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[/\-_. ]+/)
    .filter(t => t.length >= 4 && !SKIP_TOKENS.has(t));
}

/**
 * Compute the read-only PR relevance level for a single test failure.
 *
 * Decision logic (evaluated in order — first match wins):
 *
 *   HIGH    — the test's source file is directly present in filesChanged,
 *             OR 2 or more keyword tokens from the test name match tokens
 *             found in any changed file path.
 *
 *   MEDIUM  — exactly 1 keyword token from the test name matches a token
 *             in any changed file path.
 *
 *   LOW     — no token overlap found.
 *
 *   UNKNOWN — prContext is null (no PR metadata provided).
 *
 * This function is purely read-only and never influences any decision.
 */
export function getPrRelevance(
  testName:  string,
  file:      string,
  prContext: PrContext | null,
): PrRelevance {
  if (prContext === null) {
    return { level: 'unknown', reasons: [] };
  }

  if (prContext.filesChanged.length === 0) {
    return { level: 'low', reasons: ['no files changed in PR context'] };
  }

  // Normalise paths for direct comparison (strip leading ./ if present).
  const normalise = (p: string): string => p.replace(/^\.\//, '');
  const changedSet = new Set(prContext.filesChanged.map(normalise));
  const normFile   = normalise(file);

  // Direct file overlap — highest confidence signal.
  if (normFile !== '' && changedSet.has(normFile)) {
    return {
      level:   'high',
      reasons: [`direct file match: ${file}`],
    };
  }

  // Keyword overlap between test name and changed file paths.
  const testTokens = new Set(tokenise(testName));
  if (testTokens.size === 0) {
    return { level: 'low', reasons: ['no meaningful tokens in test name'] };
  }

  const matchedTokens: string[] = [];
  const matchedFiles:  string[] = [];

  for (const changed of prContext.filesChanged) {
    const changedTokens = tokenise(changed);
    for (const ct of changedTokens) {
      if (testTokens.has(ct) && !matchedTokens.includes(ct)) {
        matchedTokens.push(ct);
        if (!matchedFiles.includes(changed)) {
          matchedFiles.push(changed);
        }
      }
    }
  }

  if (matchedTokens.length >= 2) {
    return {
      level:   'high',
      reasons: [
        `${matchedTokens.length} keyword matches: [${matchedTokens.join(', ')}]`,
        `matched files: [${matchedFiles.slice(0, 3).join(', ')}]`,
      ],
    };
  }

  if (matchedTokens.length === 1) {
    return {
      level:   'medium',
      reasons: [
        `1 keyword match: "${matchedTokens[0]}"`,
        `matched file: ${matchedFiles[0]}`,
      ],
    };
  }

  return { level: 'low', reasons: ['no keyword overlap with changed files'] };
}
