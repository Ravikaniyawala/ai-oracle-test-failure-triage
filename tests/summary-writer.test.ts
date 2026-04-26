/**
 * Tests for summary-writer.ts — focused on the history badge rendered per failure.
 *
 * Seeds a real SQLite DB so getRecentFailurePattern() returns controlled values
 * without any mocking. Follows the same pattern as state-store.test.ts.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { TriageCategory, type TriageResult } from '../src/types.js';
import type { SummaryOptions } from '../src/summary-writer.js';

const tmp = join(tmpdir(), 'oracle-summary-writer-test');
const DB  = join(tmp, 'test-state.db');
mkdirSync(tmp, { recursive: true });

process.env['ORACLE_STATE_DB_PATH'] = DB;

type WriteSummaryFn = (
  results: TriageResult[],
  totalTests: number,
  pipelineId: string,
  opts?: SummaryOptions,
) => string;

let writeSummary: WriteSummaryFn | null = null;
let getDb: (() => import('better-sqlite3').Database) | null = null;
let saveRun: ((p: string, n: number, r: never[], v: 'CLEAR' | 'BLOCKED') => number) | null = null;
let dbAvailable = false;

try {
  const store = await import('../src/state-store.js');
  store.initDb();
  getDb    = store.getDb;
  saveRun  = store.saveRun;
  const sw = await import('../src/summary-writer.js');
  writeSummary = sw.writeSummary;
  dbAvailable  = true;
} catch {
  console.warn('[test] better-sqlite3 unavailable on this Node version — summary-writer tests skipped');
}

const describeMaybe = dbAvailable ? describe : describe.skip;

after(() => rmSync(tmp, { recursive: true, force: true }));

// ── helpers ───────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    testName:     'checkout > applies voucher',
    errorMessage: 'Expected 200, got 500',
    errorHash:    'abc123',
    file:         'tests/checkout.spec.ts',
    duration:     1200,
    retries:      0,
    category:     TriageCategory.FLAKY,
    confidence:   0.85,
    reasoning:    'selector flakiness',
    suggestedFix: 'add retry',
    ...overrides,
  };
}

function insertFailure(runId: number, testName: string, errorHash: string, category: string): void {
  getDb!().prepare(
    `INSERT INTO failures (run_id, test_name, error_hash, category, confidence)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(runId, testName, errorHash, category, 0.9);
}

function makeRun(): number {
  return saveRun!('pipe-badge-test', 0, [], 'CLEAR');
}

// ── badge tests ───────────────────────────────────────────────────────────────

describeMaybe('writeSummary — history badge', () => {
  it('shows "First occurrence" when there is no DB history for the test+hash', () => {
    // No failures seeded for this test+hash — pattern returns undefined.
    const result = makeResult({ testName: 'fresh-test', errorHash: 'fresh-hash' });
    const md = writeSummary!([result], 10, 'pipe-badge-1');
    assert.ok(md.includes('🆕 First occurrence'), 'expected First occurrence badge');
    assert.ok(!md.includes('Seen'), 'must not show Seen badge when no history');
  });

  it('shows "First occurrence" when totalCount is exactly 1', () => {
    const runId = makeRun();
    const test  = 'test-once';
    const hash  = 'hash-once';
    insertFailure(runId, test, hash, 'FLAKY');

    const md = writeSummary!([makeResult({ testName: test, errorHash: hash })], 10, 'pipe-badge-2');
    assert.ok(md.includes('🆕 First occurrence'), 'single prior occurrence should still show First occurrence');
    assert.ok(!md.includes('Seen'), 'Seen badge must not appear for totalCount=1');
  });

  it('shows "Seen N×" using totalCount (not dominantCategoryCount)', () => {
    const runId = makeRun();
    const test  = 'test-repeat';
    const hash  = 'hash-repeat';
    // 3 FLAKY + 2 REGRESSION = 5 total; badge should read "Seen 5×"
    for (let i = 0; i < 3; i++) insertFailure(runId, test, hash, 'FLAKY');
    for (let i = 0; i < 2; i++) insertFailure(runId, test, hash, 'REGRESSION');

    const md = writeSummary!([makeResult({ testName: test, errorHash: hash })], 10, 'pipe-badge-3');
    assert.ok(
      md.includes('Seen **5×** in recent history'),
      `expected 'Seen 5×' (totalCount), got: ${md.slice(md.indexOf('Seen') === -1 ? 0 : md.indexOf('Seen'), md.indexOf('Seen') + 50)}`,
    );
    assert.ok(!md.includes('Seen **3×**'), 'must not use dominantCategoryCount (3) for the badge');
  });

  it('each failure gets its own badge derived from its own test+hash', () => {
    const runId = makeRun();

    // failure-a: 4 prior occurrences
    const testA = 'test-badge-a';
    const hashA = 'hash-badge-a';
    for (let i = 0; i < 4; i++) insertFailure(runId, testA, hashA, 'FLAKY');

    // failure-b: no prior history
    const testB = 'test-badge-b';
    const hashB = 'hash-badge-b';

    const results = [
      makeResult({ testName: testA, errorHash: hashA, category: TriageCategory.FLAKY }),
      makeResult({ testName: testB, errorHash: hashB, category: TriageCategory.REGRESSION }),
    ];

    const md = writeSummary!(results, 10, 'pipe-badge-4');
    assert.ok(md.includes('Seen **4×** in recent history'), 'failure-a should show Seen 4×');
    assert.ok(md.includes('🆕 First occurrence'), 'failure-b should show First occurrence');
  });
});

// ── cluster Jira rendering ────────────────────────────────────────────────────

describeMaybe('writeSummary — cluster Jira action lines', () => {
  it('one cluster Jira covering N tests renders as "1 Jira created" plus scope, not "N Jiras"', () => {
    const result = makeResult({ testName: 'fresh-test', errorHash: 'fresh-hash' });
    const md = writeSummary!([result], 10, 'pipe-cluster-1', {
      jirasCreated: [
        { testName: 'HTTP 404s in checkout', category: TriageCategory.REGRESSION, key: 'QA-100', clusterSize: 24 },
      ],
    });
    assert.ok(md.includes('**1 Jira created:**'),       'should show 1 Jira, not 24');
    assert.ok(!md.includes('**24 Jiras created:**'),   'must not inflate count by clusterSize');
    assert.ok(md.includes('(24 tests)'),               'should surface cluster scope next to the key');
    assert.ok(md.includes('covering **24 tests**'),    'should include a total-affected suffix');
  });

  it('two cluster Jiras sum their clusterSize for the covering-tests suffix', () => {
    const result = makeResult({ testName: 'fresh-test', errorHash: 'fresh-hash' });
    const md = writeSummary!([result], 10, 'pipe-cluster-2', {
      jirasCreated: [
        { testName: 'HTTP 404s in checkout', category: TriageCategory.REGRESSION, key: 'QA-100', clusterSize: 24 },
        { testName: 'Auth failures',         category: TriageCategory.ENV_ISSUE,  key: 'QA-101', clusterSize: 10 },
      ],
    });
    assert.ok(md.includes('**2 Jiras created:**'));
    assert.ok(md.includes('covering **34 tests**'), 'covering suffix should sum cluster sizes (24 + 10)');
  });

  it('per-failure Jira (no clusterSize) renders exactly as before — no "(N tests)" scope', () => {
    const result = makeResult({ testName: 'fresh-test', errorHash: 'fresh-hash' });
    const md = writeSummary!([result], 10, 'pipe-cluster-3', {
      jirasCreated: [
        { testName: 'single test name', category: TriageCategory.REGRESSION, key: 'QA-200' },
      ],
    });
    assert.ok(md.includes('**1 Jira created:**'));
    assert.ok(!md.includes('(1 tests)'),          'single-test Jira should not show (1 tests)');
    assert.ok(!md.includes('covering **'),        'single-test Jira should not show covering-tests suffix');
  });
});
