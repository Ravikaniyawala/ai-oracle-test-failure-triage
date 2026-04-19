/**
 * Failure clustering — groups TriageResult[] by root cause so the policy
 * engine can propose one Jira ticket per cluster instead of one per failure.
 *
 * Rules (applied in order, first match wins per failure):
 *
 *  1. REGRESSION + HTTP 404 response          → "regression:http_404"
 *  2. ENV_ISSUE  + auth error (401/403/Unauthorized)  → "env:auth_failure"
 *  3. ENV_ISSUE  + TimeoutError               → "env:timeout:<step>"
 *  4. Any category + identical first Error line → "<cat>:exact:<line>"
 *  5. Fallback                                → "solo:<testName>:<errorHash>"
 *
 * Solo clusters (rule 5) are still modelled as a FailureCluster with one
 * member so the rest of the pipeline can treat all Jira proposals uniformly.
 */
import { createHash } from 'crypto';
import { TriageCategory, type FailureCluster, type PatternStats, type TriageResult } from './types.js';

// ── Cluster key computation ───────────────────────────────────────────────────

/**
 * Normalize a test file path to a stable identifier suitable for cluster keys.
 * Strips directory prefixes, known test suffixes (.spec / .test), and lowercases.
 * Returns an empty string if no useful basename is available.
 */
function fileStem(file: string): string {
  if (!file) return '';
  const base = file.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.(spec|test)\.[jt]sx?$/i, '').toLowerCase();
}

/**
 * Compute a stable cluster key for a single triaged failure.
 * The key is human-readable and used as the fingerprint seed for Jira dedup.
 */
export function computeClusterKey(result: TriageResult): string {
  const msg = result.errorMessage ?? '';
  const cat = result.category;

  // 1. REGRESSION: HTTP 404 — possible routing, taxonomy, or deployment change.
  //    Key includes the test-file stem so distinct feature areas (checkout,
  //    category, login, …) stay in separate clusters — the old bare
  //    `regression:http_404` over-merged unrelated defects into a single
  //    misleading Jira.
  if (
    cat === TriageCategory.REGRESSION &&
    /Received:\s*404/.test(msg)
  ) {
    const stem = fileStem(result.file);
    return stem ? `regression:http_404:${stem}` : 'regression:http_404:unknown';
  }

  // 2. ENV_ISSUE: authentication failures (401 / 403 / Unauthorized / Forbidden)
  if (
    cat === TriageCategory.ENV_ISSUE &&
    /\b(401|403|Unauthorized|Forbidden)\b/.test(msg)
  ) {
    return 'env:auth_failure';
  }

  // 3. ENV_ISSUE: timeout — group by the failing operation (e.g. "locator.fill")
  //    Stop at ':' (the separator before "Timeout Nms exceeded"), not at '.'
  //    so "locator.fill" is captured in full.
  if (cat === TriageCategory.ENV_ISSUE) {
    const m = msg.match(/TimeoutError:\s*([^:\n]{1,80})/);
    if (m?.[1]) return `env:timeout:${m[1].trim()}`;
  }

  // 4. Any category: same first Error: / TimeoutError: line → cluster together
  const firstErrLine = msg
    .split('\n')
    .map(l => l.trim())
    .find(l => /^(Error|TimeoutError):/.test(l));
  if (firstErrLine) {
    return `${cat.toLowerCase()}:exact:${firstErrLine.slice(0, 120)}`;
  }

  // 5. Fallback: one cluster per failure
  return `solo:${result.testName}:${result.errorHash}`;
}

// ── Cluster title + body generation ──────────────────────────────────────────

function clusterFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function buildJiraTitle(clusterKey: string, count: number, cat: TriageCategory): string {
  const label = `[${cat}]`;
  const n     = count === 1 ? '1 test' : `${count} tests`;

  if (clusterKey.startsWith('regression:http_404:')) {
    const stem = clusterKey.slice('regression:http_404:'.length);
    const area = stem === 'unknown' ? '' : ` in ${stem}`;
    return `${label} HTTP 404s${area} — possible routing or taxonomy change (${n} affected)`;
  }
  if (clusterKey === 'env:auth_failure') {
    return `${label} Authentication failure (401/403) — test account unavailable (${n} affected)`;
  }
  if (clusterKey.startsWith('env:timeout:')) {
    const step = clusterKey.slice('env:timeout:'.length);
    return `${label} Timeout on '${step}' — environment not ready (${n} affected)`;
  }
  if (clusterKey.includes(':exact:')) {
    const msg = clusterKey.split(':exact:')[1] ?? clusterKey;
    return `${label} ${msg} (${n} affected)`;
  }
  // solo
  return `${label} ${clusterKey.split(':').slice(1, -1).join(' › ')} (1 test)`;
}

function buildJiraBody(cluster: Pick<FailureCluster, 'clusterKey' | 'failures'>): string {
  const { clusterKey, failures } = cluster;

  const rootCause = (() => {
    if (clusterKey.startsWith('regression:http_404:')) {
      const stem = clusterKey.slice('regression:http_404:'.length);
      const area = stem === 'unknown' ? 'multiple tests' : `tests in \`${stem}\``;
      return `${area} returned HTTP 404 against this environment. Likely a routing, taxonomy, slug, or deployment change affecting that feature area — verify the URLs, fixtures, and any recent routing/CDN configuration.`;
    }
    if (clusterKey === 'env:auth_failure')
      return 'The test account returned 401/403 during login. The test user credentials may be expired, rotated, or the account may have been disabled in this environment.';
    if (clusterKey.startsWith('env:timeout:')) {
      const step = clusterKey.slice('env:timeout:'.length);
      return `Tests timed out while waiting for '${step}'. The environment may be unreachable, the login flow may be broken, or a dependency service may be down.`;
    }
    const exactMsg = clusterKey.split(':exact:')[1];
    if (exactMsg) return exactMsg;
    return 'See error details below.';
  })();

  const testList = failures
    .map(f => `- ${f.testName}  (confidence ${(f.confidence * 100).toFixed(0)}%, ${f.category})`)
    .join('\n');

  const suggestedFix = failures
    .map(f => f.suggestedFix)
    .filter(Boolean)
    .find(() => true) ?? '';

  return [
    `*Root cause:* ${rootCause}`,
    '',
    `*Affected tests (${failures.length}):*`,
    testList,
    ...(suggestedFix ? ['', `*Suggested fix:* ${suggestedFix}`] : []),
    '',
    '_Ticket created automatically by Oracle CI triage._',
  ].join('\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Group triaged failures into clusters that share a common root cause.
 *
 * @param results   - Classified failures from the LLM triage step.
 * @param failureIds - SQLite row IDs for each result (parallel array).
 * @returns One FailureCluster per distinct root cause, sorted by descending
 *          cluster size (largest first so the most impactful tickets surface).
 */
export function clusterFailures(
  results:    TriageResult[],
  failureIds: number[],
): FailureCluster[] {
  // Group by cluster key
  const byKey = new Map<string, { results: TriageResult[]; ids: number[] }>();

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const id     = failureIds[i];
    if (result === undefined || id === undefined) continue;

    const key = computeClusterKey(result);
    const existing = byKey.get(key);
    if (existing) {
      existing.results.push(result);
      existing.ids.push(id);
    } else {
      byKey.set(key, { results: [result], ids: [id] });
    }
  }

  const clusters: FailureCluster[] = [];

  for (const [key, { results: members, ids }] of byKey) {
    // Dominant category = most frequent; tie-break by severity order
    const catCounts = new Map<TriageCategory, number>();
    for (const r of members) {
      catCounts.set(r.category, (catCounts.get(r.category) ?? 0) + 1);
    }
    const severity: TriageCategory[] = [
      TriageCategory.NEW_BUG,
      TriageCategory.REGRESSION,
      TriageCategory.ENV_ISSUE,
      TriageCategory.FLAKY,
    ];
    const dominantCat = severity.find(c => (catCounts.get(c) ?? 0) > 0)
      ?? members[0]?.category
      ?? TriageCategory.ENV_ISSUE;

    const meanConf = members.reduce((s, r) => s + r.confidence, 0) / members.length;

    const partial = { clusterKey: key, failures: members };
    clusters.push({
      clusterKey:  key,
      fingerprint: clusterFingerprint(key),
      category:    dominantCat,
      confidence:  Math.round(meanConf * 100) / 100,
      failures:    members,
      failureIds:  ids,
      jiraTitle:   buildJiraTitle(key, members.length, dominantCat),
      jiraBody:    buildJiraBody(partial),
    });
  }

  // Largest clusters first — most impactful tickets surface at the top
  return clusters.sort((a, b) => b.failures.length - a.failures.length);
}

// ── Cluster-level helpers (used by the index.ts orchestration) ───────────────

/**
 * Sum PatternStats across every member of a cluster so history-based
 * suppression reflects the whole cluster, not a single representative.
 *
 * jiraDuplicateCount / jiraCreatedCount are counted per testName+errorHash,
 * so summing is the correct aggregation for the "if ≥ half of past Jiras for
 * this pattern were closed as duplicates, reject a new one" rule. Before this
 * aggregation, cluster suppression depended entirely on whichever member
 * happened to be cluster.failures[0] — arbitrary, and prone to both missing
 * real duplicate evidence from other members and wrongly suppressing a new
 * cluster based on one representative's history.
 *
 * Retry counters are summed too for consistency even though cluster-level
 * create_jira does not currently use them.
 */
export function aggregateClusterStats(
  cluster:         FailureCluster,
  patternStatsMap: Map<string, PatternStats>,
): PatternStats {
  const agg: PatternStats = {
    actionCount:        0,
    jiraCreatedCount:   0,
    jiraDuplicateCount: 0,
    retryPassedCount:   0,
    retryFailedCount:   0,
  };
  for (const f of cluster.failures) {
    const s = patternStatsMap.get(`${f.testName}:${f.errorHash}`);
    if (!s) continue;
    agg.actionCount        += s.actionCount;
    agg.jiraCreatedCount   += s.jiraCreatedCount;
    agg.jiraDuplicateCount += s.jiraDuplicateCount;
    agg.retryPassedCount   += s.retryPassedCount;
    agg.retryFailedCount   += s.retryFailedCount;
  }
  return agg;
}

/**
 * Strip the "[CATEGORY]" prefix and " (N tests affected)" suffix from the
 * cluster's Jira title so Slack and the step summary can render a clean
 * display label — the test count is carried separately via JiraCreated.clusterSize.
 */
export function clusterDisplayTitle(jiraTitle: string): string {
  return jiraTitle
    .replace(/^\[[A-Z_]+\]\s*/,                '')   // strip "[REGRESSION] "
    .replace(/\s*\(\d+\s+tests?\s+affected\)$/, '');
}
