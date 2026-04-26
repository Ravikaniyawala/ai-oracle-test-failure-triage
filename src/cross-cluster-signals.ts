/**
 * Cross-cluster signal detection.
 *
 * After failures are clustered by root cause, this module scans across
 * clusters looking for common tokens that suggest a shared underlying cause —
 * e.g. the same test persona appearing in two otherwise unrelated clusters,
 * or the same missing environment variable referenced in multiple error msgs.
 *
 * Signals are advisory only: they appear in CI logs and the decision summary
 * but do not change verdict or action proposals.
 */
import type { FailureCluster } from './types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SignalType =
  | 'test_persona'   // Same named test user/persona across clusters
  | 'suite_area'     // Same top-level test suite in multiple clusters
  | 'quoted_value'   // Same quoted string in error messages
  | 'env_var';       // Same SCREAMING_SNAKE_CASE env-var token

export interface CrossClusterSignal {
  type:         SignalType;
  token:        string;
  clusterKeys:  string[];
  clusterCount: number;
  description:  string;
}

// ── Token extraction ──────────────────────────────────────────────────────────

/**
 * Words that are common in test output and should not be treated as signals
 * even if they appear in multiple clusters.
 */
const BLOCKLIST = new Set([
  'TimeoutError', 'Error', 'Expected', 'Received', 'Object', 'String',
  'Number', 'Boolean', 'Array', 'Promise', 'JavaScript', 'TypeScript',
  'Playwright', 'PlaywrightTest', 'TestCase', 'TestSuite', 'Suite',
  'Navigation', 'Menu', 'Page', 'Test', 'User', 'Type', 'Example',
  'Verify', 'Check', 'View', 'Click', 'Open', 'Close', 'Login', 'Logout',
  'Desktop', 'Mobile', 'Safari', 'Chrome', 'Firefox', 'Edge',
  'New', 'World', 'Save', 'Pak', 'True', 'False', 'Null', 'Undefined',
]);

function extractPersonaTokens(testName: string): string[] {
  const tokens: string[] = [];

  // Split on the separator used in Playwright/BDD test names
  const segments = testName.split(/\s*[›>]\s*/).map(s => s.trim());

  for (const seg of segments) {
    // PascalCase compound words — hallmark of test persona names (EarlieEddie, NewWorldDollars)
    const camelMatches = seg.match(/\b[A-Z][a-z]+[A-Z][a-zA-Z]+\b/g) ?? [];
    tokens.push(...camelMatches);

    // After "User Type -" / "as" / "logged in as" etc.
    const userTypeMatch = seg.match(/(?:User\s+Type|logged\s+in\s+as|sign(?:ed)?\s+in\s+as)\s*[-–]?\s*([A-Za-z][A-Za-z0-9]+(?:\s[A-Za-z][A-Za-z0-9]+)?)/i);
    if (userTypeMatch?.[1]) tokens.push(userTypeMatch[1].trim());

    // Segment starts with a capitalized identifier followed by a dash (e.g. "EarlieEddie - enabled")
    const leadingIdMatch = seg.match(/^([A-Z][a-zA-Z0-9]{2,})\s*[-–]/);
    if (leadingIdMatch?.[1]) tokens.push(leadingIdMatch[1]);
  }

  return tokens.filter(t => t.length >= 4 && !BLOCKLIST.has(t));
}

function extractSuiteArea(testName: string): string | null {
  // First segment before › is the top-level suite
  const first = testName.split(/\s*[›>]\s*/)[0]?.trim();
  // Strip leading "New World - " / "PAK'nSave - " brand prefixes to get the feature area
  const area = first?.replace(/^[^-]+-\s*/, '').trim();
  return area && area.length >= 3 ? area : null;
}

function extractQuotedTokens(errorMessage: string): string[] {
  const tokens: string[] = [];
  // Single or double quoted strings of 3–60 chars that look meaningful
  const matches = errorMessage.matchAll(/["']([^"'\n]{3,60})["']/g);
  for (const m of matches) {
    const t = m[1]?.trim() ?? '';
    // Skip obvious noise: numbers-only, very generic phrases, paths
    if (!t || /^\d+$/.test(t) || t.includes('/') || t.includes('\\')) continue;
    if (BLOCKLIST.has(t)) continue;
    tokens.push(t);
  }
  return tokens;
}

function extractEnvVarTokens(errorMessage: string): string[] {
  // SCREAMING_SNAKE_CASE identifiers of 4+ chars — likely env vars or config keys
  const matches = errorMessage.match(/\b([A-Z][A-Z0-9_]{3,})\b/g) ?? [];
  return matches.filter(t => !BLOCKLIST.has(t) && t.includes('_'));
}

// ── Signal detection ──────────────────────────────────────────────────────────

/**
 * For each cluster, collect a map of token → Set<clusterKey> across all
 * token types. Then emit a signal for every token that appears in 2+ clusters.
 */
export function detectCrossClusterSignals(
  clusters: FailureCluster[],
): CrossClusterSignal[] {
  if (clusters.length < 2) return [];

  // token maps per signal type
  const personaMap  = new Map<string, Set<string>>();
  const suiteMap    = new Map<string, Set<string>>();
  const quotedMap   = new Map<string, Set<string>>();
  const envVarMap   = new Map<string, Set<string>>();

  function add(map: Map<string, Set<string>>, token: string, key: string): void {
    const s = map.get(token) ?? new Set<string>();
    s.add(key);
    map.set(token, s);
  }

  for (const cluster of clusters) {
    const key = cluster.clusterKey;

    for (const f of cluster.failures) {
      for (const t of extractPersonaTokens(f.testName)) add(personaMap, t, key);
      for (const t of extractQuotedTokens(f.errorMessage))  add(quotedMap, t, key);
      for (const t of extractEnvVarTokens(f.errorMessage))  add(envVarMap, t, key);
    }

    // Suite area: use the first failure as representative
    const rep = cluster.failures[0];
    if (rep) {
      const area = extractSuiteArea(rep.testName);
      if (area) add(suiteMap, area, key);
    }
  }

  const signals: CrossClusterSignal[] = [];

  function emit(
    map: Map<string, Set<string>>,
    type: SignalType,
    describe: (token: string, keys: string[]) => string,
  ): void {
    for (const [token, keys] of map) {
      if (keys.size < 2) continue;
      const clusterKeys = [...keys];
      signals.push({
        type,
        token,
        clusterKeys,
        clusterCount: clusterKeys.length,
        description:  describe(token, clusterKeys),
      });
    }
  }

  emit(personaMap, 'test_persona', (token, keys) =>
    `"${token}" appears in ${keys.length} clusters — possible shared test-account root cause`,
  );
  emit(suiteMap, 'suite_area', (token, keys) =>
    `feature area "${token}" has failures in ${keys.length} clusters`,
  );
  emit(quotedMap, 'quoted_value', (token, keys) =>
    `value "${token}" referenced in ${keys.length} clusters`,
  );
  emit(envVarMap, 'env_var', (token, keys) =>
    `env/config token "${token}" mentioned in ${keys.length} clusters — may share an infrastructure root cause`,
  );

  // Sort by descending cluster count so the strongest signals appear first
  return signals.sort((a, b) => b.clusterCount - a.clusterCount);
}

/**
 * Format signals as a compact markdown block for inclusion in the
 * oracle-decision-summary.md and GitHub Step Summary.
 */
export function formatSignals(signals: CrossClusterSignal[]): string {
  if (signals.length === 0) return '';

  const icon: Record<SignalType, string> = {
    test_persona:  '👤',
    suite_area:    '📁',
    quoted_value:  '🔤',
    env_var:       '⚙️',
  };

  const lines = signals.map(s => `- ${icon[s.type]} ${s.description}`);
  return `### Cross-cluster signals\n\n${lines.join('\n')}\n`;
}
