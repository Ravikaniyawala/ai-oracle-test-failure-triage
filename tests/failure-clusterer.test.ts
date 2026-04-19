/**
 * Tests for src/failure-clusterer.ts
 *
 * All tests use synthetic TriageResult fixtures — no DB, no network calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clusterFailures, computeClusterKey } from '../src/failure-clusterer.js';
import { TriageCategory, type TriageResult } from '../src/types.js';

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
  it('groups REGRESSION + 404 → regression:http_404', () => {
    const r = makeResult({
      category:     TriageCategory.REGRESSION,
      errorMessage: 'expect(received).toBe(expected)\nExpected: 200\nReceived: 404',
    });
    assert.equal(computeClusterKey(r), 'regression:http_404');
  });

  it('does NOT cluster REGRESSION without 404 as regression:http_404', () => {
    const r = makeResult({
      category:     TriageCategory.REGRESSION,
      errorMessage: 'Error: value mismatch\nExpected: foo\nReceived: bar',
    });
    assert.notEqual(computeClusterKey(r), 'regression:http_404');
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
  it('groups 19 HTTP-404 REGRESSION failures into one cluster', () => {
    const failures = Array.from({ length: 19 }, (_, i) =>
      makeResult({
        testName:     `Suite > category test ${i}`,
        errorHash:    `hash${i}`,
        category:     TriageCategory.REGRESSION,
        errorMessage: `Error: page not found\nExpected: 200\nReceived: 404\nURL: /shop/category/dept${i}/sub`,
      }),
    );
    const ids = failures.map((_, i) => i + 1);

    const clusters = clusterFailures(failures, ids);
    assert.equal(clusters.length, 1, 'all 404s should form one cluster');
    assert.equal(clusters[0]?.clusterKey,        'regression:http_404');
    assert.equal(clusters[0]?.failures.length,   19);
    assert.equal(clusters[0]?.failureIds.length, 19);
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
    const r404a = makeResult({ testName: 'Cat A', errorHash: 'r1', category: TriageCategory.REGRESSION, errorMessage: 'Expected: 200\nReceived: 404' });
    const r404b = makeResult({ testName: 'Cat B', errorHash: 'r2', category: TriageCategory.REGRESSION, errorMessage: 'Expected: 200\nReceived: 404' });
    const auth  = makeResult({ testName: 'Login', errorHash: 'a1', category: TriageCategory.ENV_ISSUE,  errorMessage: 'Error: Login 401 Unauthorized' });
    const bug   = makeResult({ testName: 'New feature', errorHash: 'n1', category: TriageCategory.NEW_BUG, errorMessage: 'Error: checkout endpoint returned 500' });

    const clusters = clusterFailures([r404a, r404b, auth, bug], [1, 2, 3, 4]);
    assert.equal(clusters.length, 3, 'expect 3 clusters: 404, auth, new_bug');

    const clustersByKey = Object.fromEntries(clusters.map(c => [c.clusterKey, c]));
    assert.equal(clustersByKey['regression:http_404']?.failures.length, 2);
    assert.equal(clustersByKey['env:auth_failure']?.failures.length,    1);
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
