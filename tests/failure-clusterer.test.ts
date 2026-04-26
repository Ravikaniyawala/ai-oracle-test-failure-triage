/**
 * Tests for src/failure-clusterer.ts
 *
 * All tests use synthetic TriageResult fixtures — no DB, no network calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateClusterStats,
  clusterDisplayTitle,
  clusterFailures,
  computeClusterKey,
  dominantCategory,
} from '../src/failure-clusterer.js';
import { TriageCategory, type FailureCluster, type PatternStats, type TriageResult } from '../src/types.js';

// ── Fixture builder ───────────────────────────────────────────────────────────

function makeResult(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    testName:     'Suite > default test',
    errorMessage: 'Error: something went wrong',
    errorHash:    'abc123',
    file:         'tests/example.spec.ts',
    duration:     1000,
    retries:      0,
    category:     TriageCategory.REGRESSION,
    confidence:   0.85,
    reasoning:    'default reasoning',
    suggestedFix: 'default fix',
    ...overrides,
  };
}

// ── computeClusterKey ─────────────────────────────────────────────────────────

describe('computeClusterKey', () => {
  it('groups REGRESSION + 404 → regression:http_404:<fileStem> using test file', () => {
    const r = makeResult({
      category:     TriageCategory.REGRESSION,
      errorMessage: 'expect(received).toBe(expected)\nExpected: 200\nReceived: 404',
      file:         'tests/category-page.spec.ts',
    });
    assert.equal(computeClusterKey(r), 'regression:http_404:category-page');
  });

  it('splits 404s from different test files into separate clusters (no over-merging)', () => {
    const category = makeResult({
      category:     TriageCategory.REGRESSION,
      errorMessage: 'Expected: 200\nReceived: 404',
      file:         'tests/category.spec.ts',
    });
    const checkout = makeResult({
      category:     TriageCategory.REGRESSION,
      errorMessage: 'Expected: 200\nReceived: 404',
      file:         'tests/checkout.spec.ts',
    });
    assert.notEqual(
      computeClusterKey(category),
      computeClusterKey(checkout),
      '404s from different features should not collapse into one cluster',
    );
  });

  it('falls back to regression:http_404:unknown when file is empty', () => {
    const r = makeResult({
      category:     TriageCategory.REGRESSION,
      errorMessage: 'Expected: 200\nReceived: 404',
      file:         '',
    });
    assert.equal(computeClusterKey(r), 'regression:http_404:unknown');
  });

  it('does NOT cluster REGRESSION without 404 as regression:http_404', () => {
    const r = makeResult({
      category:     TriageCategory.REGRESSION,
      errorMessage: 'Error: value mismatch\nExpected: foo\nReceived: bar',
    });
    assert.ok(!computeClusterKey(r).startsWith('regression:http_404'));
  });

  it('groups ENV_ISSUE + 401 → env:auth_failure', () => {
    const r = makeResult({
      category:     TriageCategory.ENV_ISSUE,
      errorMessage: 'Error: Login failed with status 401: Unauthorized',
    });
    assert.equal(computeClusterKey(r), 'env:auth_failure');
  });

  it('groups ENV_ISSUE + Forbidden → env:auth_failure', () => {
    const r = makeResult({
      category:     TriageCategory.ENV_ISSUE,
      errorMessage: 'Error: request returned 403 Forbidden',
    });
    assert.equal(computeClusterKey(r), 'env:auth_failure');
  });

  it('groups ENV_ISSUE + TimeoutError → env:timeout:<step>', () => {
    const r = makeResult({
      category:     TriageCategory.ENV_ISSUE,
      errorMessage: 'TimeoutError: locator.fill: Timeout 25000ms exceeded.',
    });
    const key = computeClusterKey(r);
    assert.ok(key.startsWith('env:timeout:'), `expected env:timeout: prefix, got ${key}`);
    assert.ok(key.includes('locator.fill'), `expected step in key, got ${key}`);
  });

  it('groups any category with identical Error: line → <cat>:exact:<line>', () => {
    const r = makeResult({
      category:     TriageCategory.ENV_ISSUE,
      errorMessage: "    Error: Category URL for 'fresh-foods-and-bakery' not found in test data\n  at step.ts:10",
    });
    const key = computeClusterKey(r);
    assert.ok(key.startsWith('env_issue:exact:'), `got: ${key}`);
    assert.ok(key.includes('fresh-foods-and-bakery'));
  });

  it('falls back to solo:<testName>:<errorHash> for unrecognised errors', () => {
    const r = makeResult({
      category:     TriageCategory.FLAKY,
      testName:     'Suite > unique test',
      errorHash:    'deadbeef',
      errorMessage: 'some totally unique error with no recognisable pattern',
    });
    assert.equal(computeClusterKey(r), 'solo:Suite > unique test:deadbeef');
  });

  it('different TimeoutError steps produce different cluster keys', () => {
    const r1 = makeResult({ category: TriageCategory.ENV_ISSUE, errorMessage: 'TimeoutError: locator.click: Timeout exceeded.' });
    const r2 = makeResult({ category: TriageCategory.ENV_ISSUE, errorMessage: 'TimeoutError: locator.fill: Timeout exceeded.' });
    assert.notEqual(computeClusterKey(r1), computeClusterKey(r2));
  });
});

// ── clusterFailures ───────────────────────────────────────────────────────────

describe('clusterFailures', () => {
  it('groups 19 HTTP-404 REGRESSION failures from the same test file into one cluster', () => {
    const failures = Array.from({ length: 19 }, (_, i) =>
      makeResult({
        testName:     `Suite > category test ${i}`,
        errorHash:    `hash${i}`,
        category:     TriageCategory.REGRESSION,
        file:         'tests/category-page.spec.ts',
        errorMessage: `Error: page not found\nExpected: 200\nReceived: 404\nURL: /shop/category/dept${i}/sub`,
      }),
    );
    const ids = failures.map((_, i) => i + 1);

    const clusters = clusterFailures(failures, ids);
    assert.equal(clusters.length, 1, 'all 404s in the same file should form one cluster');
    assert.equal(clusters[0]?.clusterKey,        'regression:http_404:category-page');
    assert.equal(clusters[0]?.failures.length,   19);
    assert.equal(clusters[0]?.failureIds.length, 19);
  });

  it('splits 404s from different test files into distinct clusters', () => {
    const category = Array.from({ length: 3 }, (_, i) =>
      makeResult({
        testName:     `Category > test ${i}`,
        errorHash:    `c${i}`,
        category:     TriageCategory.REGRESSION,
        file:         'tests/category.spec.ts',
        errorMessage: 'Expected: 200\nReceived: 404',
      }),
    );
    const checkout = Array.from({ length: 2 }, (_, i) =>
      makeResult({
        testName:     `Checkout > test ${i}`,
        errorHash:    `k${i}`,
        category:     TriageCategory.REGRESSION,
        file:         'tests/checkout.spec.ts',
        errorMessage: 'Expected: 200\nReceived: 404',
      }),
    );
    const all = [...category, ...checkout];
    const clusters = clusterFailures(all, all.map((_, i) => i + 1));
    assert.equal(clusters.length, 2, 'different test files produce different clusters');
    const keys = clusters.map(c => c.clusterKey).sort();
    assert.deepEqual(keys, ['regression:http_404:category', 'regression:http_404:checkout']);
  });

  it('jiraTitle for http_404 includes the feature area and avoids misleading "category" wording', () => {
    const failures = Array.from({ length: 2 }, (_, i) =>
      makeResult({
        testName:     `Checkout > test ${i}`,
        errorHash:    `k${i}`,
        category:     TriageCategory.REGRESSION,
        file:         'tests/checkout.spec.ts',
        errorMessage: 'Expected: 200\nReceived: 404',
      }),
    );
    const [c] = clusterFailures(failures, [1, 2]);
    assert.ok(c?.jiraTitle.includes('checkout'),     `title should include feature area: ${c?.jiraTitle}`);
    assert.ok(!/Category URL 404s/i.test(c?.jiraTitle ?? ''),
      'title must not hard-code the word "Category" — that was the over-merge bug');
  });

  it('groups auth+timeout ENV failures into separate clusters', () => {
    const auth = makeResult({
      testName: 'My Lists > create list', errorHash: 'auth01',
      category: TriageCategory.ENV_ISSUE,
      errorMessage: 'Error: Login failed with status 401: Unauthorized',
    });
    const t1 = makeResult({
      testName: 'My Orders > view orders', errorHash: 'to01',
      category: TriageCategory.ENV_ISSUE,
      errorMessage: 'TimeoutError: locator.fill: Timeout 25000ms exceeded.',
    });
    const t2 = makeResult({
      testName: 'My Orders > filter', errorHash: 'to02',
      category: TriageCategory.ENV_ISSUE,
      errorMessage: 'TimeoutError: locator.fill: Timeout 25000ms exceeded.',
    });

    const clusters = clusterFailures([auth, t1, t2], [1, 2, 3]);
    assert.equal(clusters.length, 2, 'auth and timeout should be separate clusters');
    const keys = clusters.map(c => c.clusterKey).sort();
    assert.ok(keys.some(k => k === 'env:auth_failure'));
    assert.ok(keys.some(k => k.startsWith('env:timeout:')));
  });

  it('handles mixed categories: 404 REGRESSION + auth ENV + solo NEW_BUG', () => {
    const r404a = makeResult({ testName: 'Cat A', errorHash: 'r1', category: TriageCategory.REGRESSION, file: 'tests/example.spec.ts', errorMessage: 'Expected: 200\nReceived: 404' });
    const r404b = makeResult({ testName: 'Cat B', errorHash: 'r2', category: TriageCategory.REGRESSION, file: 'tests/example.spec.ts', errorMessage: 'Expected: 200\nReceived: 404' });
    const auth  = makeResult({ testName: 'Login', errorHash: 'a1', category: TriageCategory.ENV_ISSUE,  errorMessage: 'Error: Login 401 Unauthorized' });
    const bug   = makeResult({ testName: 'New feature', errorHash: 'n1', category: TriageCategory.NEW_BUG, errorMessage: 'Error: checkout endpoint returned 500' });

    const clusters = clusterFailures([r404a, r404b, auth, bug], [1, 2, 3, 4]);
    assert.equal(clusters.length, 3, 'expect 3 clusters: 404, auth, new_bug');

    const clustersByKey = Object.fromEntries(clusters.map(c => [c.clusterKey, c]));
    assert.equal(clustersByKey['regression:http_404:example']?.failures.length, 2);
    assert.equal(clustersByKey['env:auth_failure']?.failures.length,            1);
  });

  it('solo failures each get their own cluster', () => {
    const results = [
      makeResult({ testName: 'A', errorHash: 'h1', errorMessage: 'some unique error 1' }),
      makeResult({ testName: 'B', errorHash: 'h2', errorMessage: 'some unique error 2' }),
    ];
    const clusters = clusterFailures(results, [1, 2]);
    assert.equal(clusters.length, 2, 'two distinct solo failures → two clusters');
  });

  it('sorts clusters largest-first', () => {
    const big = Array.from({ length: 5 }, (_, i) =>
      makeResult({ testName: `Big ${i}`, errorHash: `b${i}`, errorMessage: 'Expected: 200\nReceived: 404' }),
    );
    const small = [makeResult({ testName: 'Small 1', errorHash: 's1', errorMessage: 'some unique error' })];
    const clusters = clusterFailures([...small, ...big], [1, 2, 3, 4, 5, 6]);
    assert.ok(
      clusters[0] !== undefined && clusters[0].failures.length >= clusters[1]!.failures.length,
      'largest cluster should be first',
    );
  });

  it('cluster fingerprint is stable across calls (deterministic)', () => {
    const result = makeResult({ category: TriageCategory.REGRESSION, errorMessage: 'Expected: 200\nReceived: 404' });
    const [c1] = clusterFailures([result], [1]);
    const [c2] = clusterFailures([result], [1]);
    assert.equal(c1?.fingerprint, c2?.fingerprint, 'fingerprint must be deterministic');
  });

  it('jiraTitle includes failure count and category', () => {
    const failures = [
      makeResult({ testName: 'T1', errorHash: 'h1', errorMessage: 'Expected: 200\nReceived: 404' }),
      makeResult({ testName: 'T2', errorHash: 'h2', errorMessage: 'Expected: 200\nReceived: 404' }),
    ];
    const [c] = clusterFailures(failures, [1, 2]);
    assert.ok(c?.jiraTitle.includes('2'), `title should mention count: ${c?.jiraTitle}`);
    assert.ok(c?.jiraTitle.toLowerCase().includes('regression') || c?.jiraTitle.includes('REGRESSION'));
  });

  it('jiraBody lists all affected test names', () => {
    const failures = [
      makeResult({ testName: 'Suite > login test', errorHash: 'h1', errorMessage: 'Expected: 200\nReceived: 404' }),
      makeResult({ testName: 'Suite > checkout test', errorHash: 'h2', errorMessage: 'Expected: 200\nReceived: 404' }),
    ];
    const [c] = clusterFailures(failures, [1, 2]);
    assert.ok(c?.jiraBody.includes('Suite > login test'),    'body should list first test');
    assert.ok(c?.jiraBody.includes('Suite > checkout test'), 'body should list second test');
  });

  it('handles empty input gracefully', () => {
    const clusters = clusterFailures([], []);
    assert.equal(clusters.length, 0);
  });

});

// ── dominantCategory ───────────────────────────────────────────────────────────
//
// Pins down the documented contract: frequency first, severity only as a
// tie-break. The previous implementation picked whichever severity bucket
// had ANY members at all, so a single NEW_BUG in a mostly-FLAKY cluster
// escalated the whole cluster to NEW_BUG and (since cluster category drives
// Jira eligibility) created tickets the cluster should not produce.

describe('dominantCategory', () => {
  it('picks the most-frequent category, NOT severity-first', () => {
    // 4 FLAKY + 1 NEW_BUG — FLAKY dominates by frequency.
    const members = [
      ...Array.from({ length: 4 }, () => makeResult({ category: TriageCategory.FLAKY })),
      makeResult({ category: TriageCategory.NEW_BUG }),
    ];
    assert.equal(
      dominantCategory(members), TriageCategory.FLAKY,
      'dominant category must follow frequency, not severity',
    );
  });

  it('severity breaks ties — NEW_BUG > REGRESSION > ENV_ISSUE > FLAKY', () => {
    // 2 FLAKY + 2 REGRESSION → tie on count, REGRESSION wins by severity.
    const tie1 = [
      ...Array.from({ length: 2 }, () => makeResult({ category: TriageCategory.FLAKY })),
      ...Array.from({ length: 2 }, () => makeResult({ category: TriageCategory.REGRESSION })),
    ];
    assert.equal(dominantCategory(tie1), TriageCategory.REGRESSION);

    // 3 REGRESSION + 3 NEW_BUG → tie; NEW_BUG wins by severity.
    const tie2 = [
      ...Array.from({ length: 3 }, () => makeResult({ category: TriageCategory.REGRESSION })),
      ...Array.from({ length: 3 }, () => makeResult({ category: TriageCategory.NEW_BUG })),
    ];
    assert.equal(dominantCategory(tie2), TriageCategory.NEW_BUG);
  });

  it('empty input returns ENV_ISSUE as a safe fallback (never NEW_BUG/REGRESSION)', () => {
    assert.equal(dominantCategory([]), TriageCategory.ENV_ISSUE);
  });

  it('single-member cluster returns that member category', () => {
    assert.equal(
      dominantCategory([makeResult({ category: TriageCategory.ENV_ISSUE })]),
      TriageCategory.ENV_ISSUE,
    );
  });
});

// ── aggregateClusterStats ─────────────────────────────────────────────────────

function makeStats(overrides: Partial<PatternStats> = {}): PatternStats {
  return {
    actionCount:        0,
    jiraCreatedCount:   0,
    jiraDuplicateCount: 0,
    retryPassedCount:   0,
    retryFailedCount:   0,
    ...overrides,
  };
}

function makeCluster(failures: TriageResult[]): FailureCluster {
  return {
    clusterKey:  'test:cluster',
    fingerprint: 'deadbeef12345678',
    category:    TriageCategory.REGRESSION,
    confidence:  0.85,
    failures,
    failureIds:  failures.map((_, i) => i + 1),
    jiraTitle:   '[REGRESSION] test cluster (1 test affected)',
    jiraBody:    'body',
  };
}

describe('aggregateClusterStats', () => {
  const zeroCluster = makeStats();

  it('sums jira + retry counters across every cluster member', () => {
    const f1 = makeResult({ testName: 'T1', errorHash: 'h1' });
    const f2 = makeResult({ testName: 'T2', errorHash: 'h2' });
    const f3 = makeResult({ testName: 'T3', errorHash: 'h3' });

    const perFailureStatsMap = new Map<string, PatternStats>([
      ['T1:h1', makeStats({ actionCount: 2, jiraCreatedCount: 3, jiraDuplicateCount: 1, retryPassedCount: 1 })],
      ['T2:h2', makeStats({ actionCount: 1, jiraCreatedCount: 1, jiraDuplicateCount: 2, retryFailedCount: 2 })],
      ['T3:h3', makeStats({ actionCount: 4, jiraCreatedCount: 0, jiraDuplicateCount: 0, retryPassedCount: 3 })],
    ]);

    const agg = aggregateClusterStats(makeCluster([f1, f2, f3]), perFailureStatsMap, zeroCluster);
    assert.equal(agg.actionCount,        2 + 1 + 4);
    assert.equal(agg.jiraCreatedCount,   3 + 1);
    assert.equal(agg.jiraDuplicateCount, 1 + 2);
    assert.equal(agg.retryPassedCount,   1 + 3);
    assert.equal(agg.retryFailedCount,   2);
  });

  it('returns zeros when no member has stats and cluster history is zero', () => {
    const agg = aggregateClusterStats(
      makeCluster([makeResult({ testName: 'X', errorHash: 'y' })]),
      new Map(),
      zeroCluster,
    );
    assert.equal(agg.actionCount,        0);
    assert.equal(agg.jiraCreatedCount,   0);
    assert.equal(agg.jiraDuplicateCount, 0);
  });

  it('does not over-suppress by picking arbitrary first member — a low-history member does not hide duplicate evidence elsewhere in the cluster', () => {
    // Cluster has two members. First member has no history. A later member
    // carries the duplicate evidence. With the old cluster.failures[0] lookup
    // this cluster would appear clean; with aggregation the evidence surfaces.
    const first = makeResult({ testName: 'First',      errorHash: 'h1' });
    const later = makeResult({ testName: 'Late dupe',  errorHash: 'h2' });
    const perFailureStatsMap = new Map<string, PatternStats>([
      ['Late dupe:h2', makeStats({ jiraCreatedCount: 4, jiraDuplicateCount: 3 })],
    ]);
    const agg = aggregateClusterStats(makeCluster([first, later]), perFailureStatsMap, zeroCluster);
    assert.equal(agg.jiraCreatedCount,   4);
    assert.equal(agg.jiraDuplicateCount, 3, 'aggregation should surface duplicate history from any cluster member');
  });

  it('adds cluster-level history exactly once, not once per member', () => {
    // Regression test for the P1 double-count flagged by Codex review:
    //   cluster-aware getPatternStats credited each member with the same
    //   historical cluster Jira; the old aggregator then summed those
    //   N copies, tripping history:duplicate_pattern suppression after a
    //   single prior duplicate cluster ticket.
    //
    // With the split, per-failure stats stay per-failure (no cluster rows),
    // and the cluster-level stats contribute exactly once.
    const f1 = makeResult({ testName: 'T1', errorHash: 'h1' });
    const f2 = makeResult({ testName: 'T2', errorHash: 'h2' });
    const f3 = makeResult({ testName: 'T3', errorHash: 'h3' });

    // Per-failure-only stats — no cluster rows attributed to members.
    const perFailureStatsMap = new Map<string, PatternStats>([
      ['T1:h1', makeStats()],
      ['T2:h2', makeStats()],
      ['T3:h3', makeStats()],
    ]);

    // One historical cluster Jira that was closed as duplicate.
    const clusterHistoryStats = makeStats({
      actionCount:        1,
      jiraCreatedCount:   1,
      jiraDuplicateCount: 1,
    });

    const agg = aggregateClusterStats(
      makeCluster([f1, f2, f3]),
      perFailureStatsMap,
      clusterHistoryStats,
    );
    assert.equal(agg.actionCount,        1, 'cluster action must be counted once, not once per member');
    assert.equal(agg.jiraCreatedCount,   1, 'cluster Jira create must be counted once, not once per member');
    assert.equal(agg.jiraDuplicateCount, 1, 'cluster duplicate closure must be counted once, not once per member');
  });

  it('combines per-failure history with cluster-level history without over-counting either stream', () => {
    const f1 = makeResult({ testName: 'T1', errorHash: 'h1' });
    const f2 = makeResult({ testName: 'T2', errorHash: 'h2' });

    // Each member has its own per-failure history (e.g. was individually Jira'd
    // in a prior run before the clusterer existed).
    const perFailureStatsMap = new Map<string, PatternStats>([
      ['T1:h1', makeStats({ jiraCreatedCount: 1, jiraDuplicateCount: 0 })],
      ['T2:h2', makeStats({ jiraCreatedCount: 1, jiraDuplicateCount: 1 })],
    ]);
    const clusterHistoryStats = makeStats({
      jiraCreatedCount:   2,
      jiraDuplicateCount: 1,
    });

    const agg = aggregateClusterStats(
      makeCluster([f1, f2]),
      perFailureStatsMap,
      clusterHistoryStats,
    );
    // Per-failure sum (1+1) + cluster once (2) = 4 — no member-count inflation.
    assert.equal(agg.jiraCreatedCount,   1 + 1 + 2);
    assert.equal(agg.jiraDuplicateCount, 0 + 1 + 1);
  });
});

// ── clusterDisplayTitle ───────────────────────────────────────────────────────

describe('clusterDisplayTitle', () => {
  it('strips the [CATEGORY] prefix and (N tests affected) suffix', () => {
    assert.equal(
      clusterDisplayTitle('[REGRESSION] HTTP 404s in checkout — possible routing or taxonomy change (24 tests affected)'),
      'HTTP 404s in checkout — possible routing or taxonomy change',
    );
  });

  it('works for singular (1 test)', () => {
    assert.equal(
      clusterDisplayTitle('[NEW_BUG] Something broke (1 test affected)'),
      'Something broke',
    );
  });

  it('leaves a title without prefix/suffix unchanged', () => {
    assert.equal(
      clusterDisplayTitle('A plain title'),
      'A plain title',
    );
  });
});
