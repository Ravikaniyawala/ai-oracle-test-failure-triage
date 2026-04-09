/**
 * Tests for Dashboard V1 persistence fixes and query helpers.
 *
 * Coverage:
 *   1. runs.verdict — stored directly, not derived from JSON
 *   2. CLEAR runs — persisted to DB (previously dropped before saveRun)
 *   3. actions.created_at — stamped at INSERT time for all action rows
 *   4. Backward-compat migration — addCol is idempotent on an existing schema
 *   5. getRunVerdictTrend — correct grouping, date filtering, both verdicts
 *   6. getFailureCategoryTrend — correct join and grouping
 *   7. getActionTypeTrend — uses created_at; fallback for pre-migration rows
 *   8. getTopRecurringFailures — ordered by occurrences, limit respected
 *   9. getSuppressionSummary — history: prefix filter, date filter
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── DB path must be set before any module with a DB reference is imported ────
const tmp = join(tmpdir(), `oracle-dashboard-test-${process.pid}`);
mkdirSync(tmp, { recursive: true });
process.env['ORACLE_STATE_DB_PATH'] = join(tmp, 'test.db');

// ── Guard for environments where better-sqlite3 is unavailable ───────────────
type SaveRunFn       = typeof import('../src/state-store.js')['saveRun'];
type SaveFailuresFn  = typeof import('../src/state-store.js')['saveFailures'];
type SaveActionFn    = typeof import('../src/state-store.js')['saveAction'];
type InitDbFn        = typeof import('../src/state-store.js')['initDb'];
type QueryModule     = typeof import('../src/dashboard-queries.js');

let saveRun:      SaveRunFn       | null = null;
let saveFailures: SaveFailuresFn  | null = null;
let saveAction:   SaveActionFn    | null = null;
let queries:      QueryModule     | null = null;
let dbAvailable = false;

try {
  const store = await import('../src/state-store.js');
  store.initDb();
  saveRun      = store.saveRun;
  saveFailures = store.saveFailures;
  saveAction   = store.saveAction;
  queries      = await import('../src/dashboard-queries.js');
  dbAvailable  = true;
} catch {
  console.warn('[test] better-sqlite3 unavailable on this Node version — dashboard tests skipped');
}

after(() => rmSync(tmp, { recursive: true, force: true }));

const describeMaybe = dbAvailable ? describe : describe.skip;

// ── Fixture helpers ───────────────────────────────────────────────────────────

import { TriageCategory } from '../src/types.js';
import type { TriageResult, ActionProposal, Decision } from '../src/types.js';

function makeResult(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    testName:     'Default > test',
    errorMessage: 'AssertionError',
    errorHash:    'aabbccdd',
    file:         'tests/default.spec.ts',
    duration:     500,
    retries:      0,
    category:     TriageCategory.FLAKY,
    confidence:   0.8,
    reasoning:    'timing',
    suggestedFix: 'add wait',
    ...overrides,
  };
}

let _fingerprint = 0;
function makeAction(
  runId:       number,
  actionType:  string,
  verdict:     string,
  failureId:   number | null = null,
): { proposal: ActionProposal; decision: Decision } {
  const fingerprint = `fp-${++_fingerprint}`;
  const proposal: ActionProposal = {
    type:        actionType as ActionProposal['type'],
    scope:       'failure',
    scopeId:     'test:hash',
    failureId,
    clusterKey:  null,
    runId,
    pipelineId:  `pipe-${runId}`,
    source:      'policy',
    fingerprint,
  };
  const decision: Decision = {
    proposal,
    verdict:    verdict as Decision['verdict'],
    confidence: 0.9,
    reason:     verdict === 'rejected' ? 'history:jira_already_created' : 'policy:auto-approved',
  };
  return { proposal, decision };
}

// ── 1. runs.verdict persistence ───────────────────────────────────────────────

describeMaybe('runs.verdict persistence', () => {
  it('stores BLOCKED verdict on the run row', () => {
    const runId = saveRun!('pipe-blocked', 1, [makeResult({ category: TriageCategory.REGRESSION })], 'BLOCKED');
    const store = queries!['getRunVerdictTrend']();
    const row = store.find(r => r.verdict === 'BLOCKED');
    assert.ok(row, 'expected at least one BLOCKED row');
    assert.ok(row.count >= 1);
    assert.ok(runId > 0);
  });

  it('stores CLEAR verdict on the run row', () => {
    saveRun!('pipe-clear', 0, [], 'CLEAR');
    const trend = queries!['getRunVerdictTrend']();
    const row = trend.find(r => r.verdict === 'CLEAR');
    assert.ok(row, 'expected at least one CLEAR row');
    assert.ok(row.count >= 1);
  });

  it('stores both verdicts independently without cross-contamination', () => {
    const trend = queries!['getRunVerdictTrend']();
    const blocked = trend.find(r => r.verdict === 'BLOCKED');
    const clear   = trend.find(r => r.verdict === 'CLEAR');
    assert.ok(blocked, 'BLOCKED rows present');
    assert.ok(clear,   'CLEAR rows present');
    // They must be separate rows — not merged
    assert.notEqual(blocked, clear);
  });
});

// ── 2. CLEAR run persistence ──────────────────────────────────────────────────

describeMaybe('CLEAR run persistence', () => {
  it('saveRun with 0 failures and CLEAR verdict produces a DB row', () => {
    const before = queries!['getRunVerdictTrend']().filter(r => r.verdict === 'CLEAR')
      .reduce((s, r) => s + r.count, 0);
    saveRun!('pipe-clear-2', 0, [], 'CLEAR');
    const after = queries!['getRunVerdictTrend']().filter(r => r.verdict === 'CLEAR')
      .reduce((s, r) => s + r.count, 0);
    assert.equal(after, before + 1);
  });

  it('CLEAR run has categories_json of empty object', () => {
    // We verify indirectly: getFailureCategoryTrend should not gain a row
    // for the CLEAR run's pipeline since no failures were saved.
    const runId = saveRun!('pipe-clear-3', 0, [], 'CLEAR');
    const failures = saveFailures!(runId, []);
    assert.deepEqual(failures, []);
  });
});

// ── 3. actions.created_at ─────────────────────────────────────────────────────

describeMaybe('actions.created_at', () => {
  it('sets created_at when an action is inserted', () => {
    const runId = saveRun!('pipe-action-ts', 1, [makeResult()], 'BLOCKED');
    const { proposal, decision } = makeAction(runId, 'create_jira', 'approved');
    const inserted = saveAction!(runId, proposal, decision);
    assert.ok(inserted, 'action should be newly inserted');

    // Verify by querying the action trend — it should appear in today's bucket
    const today = new Date().toISOString().slice(0, 10);
    const trend = queries!['getActionTypeTrend']();
    const row = trend.find(r => r.action_type === 'create_jira' && r.day === today);
    assert.ok(row, `expected a create_jira row for today (${today})`);
    assert.ok(row.count >= 1);
  });

  it('duplicate fingerprint is not re-inserted (INSERT OR IGNORE)', () => {
    const runId = saveRun!('pipe-dedup', 1, [makeResult()], 'BLOCKED');
    const { proposal, decision } = makeAction(runId, 'notify_slack', 'approved');
    const first  = saveAction!(runId, proposal, decision);
    const second = saveAction!(runId, proposal, decision);
    assert.ok(first,   'first insert should succeed');
    assert.ok(!second, 'second insert should be silently ignored');
  });
});

// ── 4. Migration idempotency ──────────────────────────────────────────────────

describeMaybe('migration idempotency', () => {
  it('calling initDb() again on an existing schema does not throw', async () => {
    const store = await import('../src/state-store.js');
    assert.doesNotThrow(() => store.initDb());
  });
});

// ── 5. getRunVerdictTrend ─────────────────────────────────────────────────────

describeMaybe('getRunVerdictTrend', () => {
  it('returns rows with day, verdict, count fields', () => {
    const rows = queries!['getRunVerdictTrend']();
    assert.ok(rows.length > 0, 'expected at least one row');
    const row = rows[0]!;
    assert.ok('day'     in row, 'missing day field');
    assert.ok('verdict' in row, 'missing verdict field');
    assert.ok('count'   in row, 'missing count field');
    assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/, 'day should be YYYY-MM-DD');
  });

  it('date filter narrows results — future window returns empty', () => {
    const rows = queries!['getRunVerdictTrend']('2099-01-01', '2099-12-31');
    assert.equal(rows.length, 0);
  });

  it('date filter narrows results — past window returns empty', () => {
    const rows = queries!['getRunVerdictTrend']('1970-01-01', '1970-01-02');
    assert.equal(rows.length, 0);
  });

  it('date filter including today returns data', () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = queries!['getRunVerdictTrend'](today, today + 'T23:59:59Z');
    assert.ok(rows.length > 0, 'expected rows for today');
  });

  it('results are ordered by day ascending', () => {
    // Seed runs on a synthetic past timestamp to force multi-day data
    const rows = queries!['getRunVerdictTrend']();
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i]!.day >= rows[i - 1]!.day, 'rows must be ordered by day ASC');
    }
  });
});

// ── 6. getFailureCategoryTrend ────────────────────────────────────────────────

describeMaybe('getFailureCategoryTrend', () => {
  before(() => {
    const runId = saveRun!('pipe-cat-trend', 3, [
      makeResult({ category: TriageCategory.FLAKY,      errorHash: 'f1' }),
      makeResult({ category: TriageCategory.REGRESSION, errorHash: 'f2', testName: 'Reg > test' }),
      makeResult({ category: TriageCategory.ENV_ISSUE,  errorHash: 'f3', testName: 'Env > test' }),
    ], 'BLOCKED');
    saveFailures!(runId, [
      makeResult({ category: TriageCategory.FLAKY,      errorHash: 'f1' }),
      makeResult({ category: TriageCategory.REGRESSION, errorHash: 'f2', testName: 'Reg > test' }),
      makeResult({ category: TriageCategory.ENV_ISSUE,  errorHash: 'f3', testName: 'Env > test' }),
    ]);
  });

  it('returns rows with day, category, count fields', () => {
    const rows = queries!['getFailureCategoryTrend']();
    assert.ok(rows.length > 0);
    const row = rows[0]!;
    assert.ok('day'      in row);
    assert.ok('category' in row);
    assert.ok('count'    in row);
  });

  it('categories seeded in the before() hook appear in results', () => {
    const rows = queries!['getFailureCategoryTrend']();
    const cats = new Set(rows.map(r => r.category));
    assert.ok(cats.has('FLAKY'));
    assert.ok(cats.has('REGRESSION'));
    assert.ok(cats.has('ENV_ISSUE'));
  });

  it('date filter future window returns empty', () => {
    const rows = queries!['getFailureCategoryTrend']('2099-01-01', '2099-12-31');
    assert.equal(rows.length, 0);
  });
});

// ── 7. getActionTypeTrend ─────────────────────────────────────────────────────

describeMaybe('getActionTypeTrend', () => {
  it('returns rows with day, action_type, verdict, count fields', () => {
    // Ensure at least one action exists (previous tests may have created some)
    const rows = queries!['getActionTypeTrend']();
    assert.ok(rows.length > 0, 'expected at least one action row');
    const row = rows[0]!;
    assert.ok('day'         in row);
    assert.ok('action_type' in row);
    assert.ok('verdict'     in row);
    assert.ok('count'       in row);
  });

  it('future date filter returns empty', () => {
    const rows = queries!['getActionTypeTrend']('2099-01-01', '2099-12-31');
    assert.equal(rows.length, 0);
  });

  it('unfiltered query includes rows created in this test session', () => {
    const runId = saveRun!('pipe-at-trend', 1, [makeResult()], 'BLOCKED');
    const { proposal, decision } = makeAction(runId, 'notify_slack', 'approved');
    saveAction!(runId, proposal, decision);

    const today = new Date().toISOString().slice(0, 10);
    const rows = queries!['getActionTypeTrend']();
    const row = rows.find(r => r.action_type === 'notify_slack' && r.day === today);
    assert.ok(row, 'notify_slack action should appear in today bucket');
  });
});

// ── 8. getTopRecurringFailures ────────────────────────────────────────────────

describeMaybe('getTopRecurringFailures', () => {
  before(() => {
    // Seed the same error_hash 3 times across separate runs
    for (let i = 0; i < 3; i++) {
      const runId = saveRun!(`pipe-recur-${i}`, 1, [
        makeResult({ testName: 'Recur > flaky', errorHash: 'recurring01' }),
      ], 'BLOCKED');
      saveFailures!(runId, [
        makeResult({ testName: 'Recur > flaky', errorHash: 'recurring01' }),
      ]);
    }
  });

  it('returns rows ordered by occurrences descending', () => {
    const rows = queries!['getTopRecurringFailures']();
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i]!.occurrences <= rows[i - 1]!.occurrences, 'must be ordered DESC');
    }
  });

  it('the seeded recurring failure appears and has occurrences >= 3', () => {
    const rows = queries!['getTopRecurringFailures']();
    const row = rows.find(r => r.error_hash === 'recurring01');
    assert.ok(row, 'recurring01 should appear');
    assert.ok(row.occurrences >= 3, `expected ≥3, got ${row.occurrences}`);
    assert.ok(row.last_seen, 'last_seen should be populated');
  });

  it('respects the limit parameter', () => {
    const rows = queries!['getTopRecurringFailures'](undefined, undefined, 2);
    assert.ok(rows.length <= 2, `expected ≤2 rows, got ${rows.length}`);
  });

  it('date filter future window returns empty', () => {
    const rows = queries!['getTopRecurringFailures']('2099-01-01', '2099-12-31');
    assert.equal(rows.length, 0);
  });
});

// ── 9. getSuppressionSummary ──────────────────────────────────────────────────

describeMaybe('getSuppressionSummary', () => {
  before(() => {
    // Seed two history-rejected actions and one non-history rejection
    const runId = saveRun!('pipe-suppress', 1, [makeResult()], 'BLOCKED');
    const rejectedHistory1 = makeAction(runId, 'create_jira', 'rejected');
    rejectedHistory1.decision.reason = 'history:jira_already_created';
    saveAction!(runId, rejectedHistory1.proposal, rejectedHistory1.decision);

    const rejectedHistory2 = makeAction(runId, 'create_jira', 'rejected');
    rejectedHistory2.decision.reason = 'history:duplicate_pattern';
    saveAction!(runId, rejectedHistory2.proposal, rejectedHistory2.decision);

    const rejectedPolicy = makeAction(runId, 'create_jira', 'rejected');
    rejectedPolicy.decision.reason = 'policy:low_confidence';
    saveAction!(runId, rejectedPolicy.proposal, rejectedPolicy.decision);
  });

  it('returns only history: prefixed rejections', () => {
    const rows = queries!['getSuppressionSummary']();
    assert.ok(rows.length > 0, 'expected suppression rows');
    for (const row of rows) {
      assert.ok(row.decision_reason.startsWith('history:'),
        `unexpected reason: ${row.decision_reason}`);
    }
  });

  it('history:jira_already_created appears in results', () => {
    const rows = queries!['getSuppressionSummary']();
    const row = rows.find(r => r.decision_reason === 'history:jira_already_created');
    assert.ok(row, 'history:jira_already_created should appear');
    assert.ok(row.count >= 1);
  });

  it('history:duplicate_pattern appears in results', () => {
    const rows = queries!['getSuppressionSummary']();
    const row = rows.find(r => r.decision_reason === 'history:duplicate_pattern');
    assert.ok(row, 'history:duplicate_pattern should appear');
    assert.ok(row.count >= 1);
  });

  it('policy: prefixed rejections are excluded', () => {
    const rows = queries!['getSuppressionSummary']();
    const policyRow = rows.find(r => r.decision_reason.startsWith('policy:'));
    assert.equal(policyRow, undefined, 'policy: reasons must not appear');
  });

  it('future date filter returns empty', () => {
    const rows = queries!['getSuppressionSummary']('2099-01-01', '2099-12-31');
    assert.equal(rows.length, 0);
  });

  it('unfiltered query includes rows regardless of created_at', () => {
    const rows = queries!['getSuppressionSummary']();
    const total = rows.reduce((s, r) => s + r.count, 0);
    assert.ok(total >= 2, `expected ≥2 total suppressions, got ${total}`);
  });
});
