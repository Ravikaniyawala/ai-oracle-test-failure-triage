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
 *   HIGH    — the failing file is directly present in filesChanged,
 *             OR 2 or more keyword tokens from testName + file path combined
 *             match tokens found in any changed file path.
 *
 *   MEDIUM  — exactly 1 keyword token from testName + file path matches a
 *             token in any changed file path.
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
      reasons: [`changed file overlaps failing file path: ${file}`],
    };
  }

  // Keyword overlap between (testName + failure file path) and changed file paths.
  // Including the file path improves monorepo coverage where the test name
  // alone may not contain enough distinguishing tokens.
  const testTokens = tokenise(testName);
  const fileTokens = tokenise(file);
  const combinedTokens = new Set([...testTokens, ...fileTokens]);

  if (combinedTokens.size === 0) {
    return { level: 'low', reasons: ['no meaningful tokens in failure name or file path'] };
  }

  const matchedTokens: string[] = [];
  const matchedFiles:  string[] = [];

  for (const changed of prContext.filesChanged) {
    const changedTokens = tokenise(changed);
    for (const ct of changedTokens) {
      if (combinedTokens.has(ct) && !matchedTokens.includes(ct)) {
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
        `${matchedTokens.length} keyword matches between failure and PR changes: [${matchedTokens.join(', ')}]`,
        `matched files: [${matchedFiles.slice(0, 3).join(', ')}]`,
      ],
    };
  }

  if (matchedTokens.length === 1) {
    return {
      level:   'medium',
      reasons: [
        `1 keyword match between failure and PR changes: "${matchedTokens[0]}"`,
        `matched file: ${matchedFiles[0]}`,
      ],
    };
  }

  return { level: 'low', reasons: ['no overlap between failure and PR changes'] };
}
