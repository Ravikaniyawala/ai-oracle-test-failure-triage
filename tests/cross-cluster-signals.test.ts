/**
 * Tests for src/cross-cluster-signals.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectCrossClusterSignals, formatSignals } from '../src/cross-cluster-signals.js';
import { TriageCategory, type FailureCluster, type TriageResult } from '../src/types.js';
import { createHash } from 'crypto';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function fp(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function makeResult(testName: string, errorMessage: string, cat = TriageCategory.REGRESSION): TriageResult {
  return {
    testName,
    errorMessage,
    errorHash:    createHash('sha256').update(testName + errorMessage).digest('hex').slice(0, 12),
    file:         'tests/example.spec.ts',
    duration:     1000,
    retries:      0,
    category:     cat,
    confidence:   0.85,
    reasoning:    '',
    suggestedFix: '',
  };
}

function makeCluster(key: string, failures: TriageResult[], cat = TriageCategory.REGRESSION): FailureCluster {
  return {
    clusterKey:  key,
    fingerprint: fp(key),
    category:    cat,
    confidence:  0.85,
    failures,
    failureIds:  failures.map((_, i) => i + 1),
    jiraTitle:   `[${cat}] ${key}`,
    jiraBody:    failures.map(f => `- ${f.testName}`).join('\n'),
  };
}

// ── detectCrossClusterSignals ─────────────────────────────────────────────────

describe('detectCrossClusterSignals', () => {
  it('returns empty array when fewer than 2 clusters', () => {
    const cluster = makeCluster('solo:test:abc', [makeResult('Suite > test', 'Error: something')]);
    assert.deepEqual(detectCrossClusterSignals([]),       []);
    assert.deepEqual(detectCrossClusterSignals([cluster]), []);
  });

  it('detects shared test persona (PascalCase compound) across two clusters', () => {
    const c1 = makeCluster('regression:http_404', [
      makeResult(
        'New World - Clubcard › User Type - EarlieEddie',
        'Error: expect(locator).toContainText failed',
      ),
    ]);
    const c2 = makeCluster('regression:exact:TimeoutError', [
      makeResult(
        'New World - Payment Page › EarlieEddie - enabled 1 SSO true',
        'TimeoutError: locator.check: Timeout 25000ms exceeded.',
      ),
    ]);

    const signals = detectCrossClusterSignals([c1, c2]);
    const personaSignal = signals.find(s => s.type === 'test_persona' && s.token === 'EarlieEddie');
    assert.ok(personaSignal, 'should detect EarlieEddie as shared persona');
    assert.equal(personaSignal.clusterCount, 2);
    assert.ok(personaSignal.description.includes('EarlieEddie'));
  });

  it('does NOT emit signal when token appears in only one cluster', () => {
    const c1 = makeCluster('cluster:a', [
      makeResult('Suite > EarlieEddie test', 'Error: something'),
    ]);
    const c2 = makeCluster('cluster:b', [
      makeResult('Suite > completely different test', 'Error: something else'),
    ]);

    const signals = detectCrossClusterSignals([c1, c2]);
    const personaSignal = signals.find(s => s.token === 'EarlieEddie');
    assert.ok(!personaSignal, 'token in only one cluster should not be a signal');
  });

  it('detects shared env var token across clusters', () => {
    const c1 = makeCluster('env:exact:Flagsmith', [
      makeResult('Suite > test A', 'Error: FLAGSMITH_FLAGS not found in local storage'),
    ], TriageCategory.ENV_ISSUE);
    const c2 = makeCluster('env:exact:Flagsmith2', [
      makeResult('Suite > test B', 'Error: Cannot read FLAGSMITH_FLAGS from env'),
    ], TriageCategory.ENV_ISSUE);

    const signals = detectCrossClusterSignals([c1, c2]);
    const envSignal = signals.find(s => s.type === 'env_var' && s.token === 'FLAGSMITH_FLAGS');
    assert.ok(envSignal, 'should detect shared FLAGSMITH_FLAGS env var');
    assert.equal(envSignal.clusterCount, 2);
  });

  it('detects shared quoted value across clusters', () => {
    const c1 = makeCluster('cluster:x', [
      makeResult('Suite > test 1', "Error: value 'fresh-foods-and-bakery' not found"),
    ]);
    const c2 = makeCluster('cluster:y', [
      makeResult('Suite > test 2', "Error: category 'fresh-foods-and-bakery' missing from nav"),
    ]);

    const signals = detectCrossClusterSignals([c1, c2]);
    const quotedSignal = signals.find(s => s.type === 'quoted_value' && s.token.includes('fresh-foods-and-bakery'));
    assert.ok(quotedSignal, 'should detect shared quoted value');
  });

  it('sorts signals by descending cluster count', () => {
    // persona appears in 3 clusters, env var in 2
    const makeC = (key: string, name: string, err: string) =>
      makeCluster(key, [makeResult(name, err)]);

    const clusters = [
      makeC('c1', 'New World - App › EarlieEddie test 1', 'Error: FLAGSMITH_FLAGS missing'),
      makeC('c2', 'New World - App › EarlieEddie test 2', 'Error: FLAGSMITH_FLAGS missing'),
      makeC('c3', 'New World - App › EarlieEddie test 3', 'Error: something unrelated'),
    ];

    const signals = detectCrossClusterSignals(clusters);
    assert.ok(signals.length > 0);
    // Highest count first
    for (let i = 1; i < signals.length; i++) {
      assert.ok(
        signals[i - 1]!.clusterCount >= signals[i]!.clusterCount,
        'signals should be sorted by descending clusterCount',
      );
    }
  });
});

// ── formatSignals ─────────────────────────────────────────────────────────────

describe('formatSignals', () => {
  it('returns empty string when no signals', () => {
    assert.equal(formatSignals([]), '');
  });

  it('includes signal description in markdown output', () => {
    const c1 = makeCluster('a', [makeResult('Suite › EarlieEddie test', 'Error: foo')]);
    const c2 = makeCluster('b', [makeResult('Other › EarlieEddie check', 'Error: bar')]);
    const signals = detectCrossClusterSignals([c1, c2]);

    const md = formatSignals(signals);
    assert.ok(md.includes('Cross-cluster signals'), 'should include section header');
    assert.ok(md.includes('EarlieEddie'),            'should mention the shared token');
  });

  it('includes emoji icon per signal type', () => {
    const c1 = makeCluster('c1', [makeResult('Suite › EarlieEddie A', 'Error: SOME_VAR missing')]);
    const c2 = makeCluster('c2', [makeResult('Suite › EarlieEddie B', 'Error: SOME_VAR not set')]);
    const signals = detectCrossClusterSignals([c1, c2]);
    const md = formatSignals(signals);
    // At least one icon should appear
    assert.ok(/[👤📁🔤⚙️]/.test(md), 'should include at least one emoji icon');
  });
});
