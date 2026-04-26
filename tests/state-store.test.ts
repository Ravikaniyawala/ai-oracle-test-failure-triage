import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ActionProposal, Decision, PatternStats, RecentFailurePattern } from '../src/types.js';

const tmp = join(tmpdir(), 'oracle-state-store-test');
const DB  = join(tmp, 'test-state.db');
mkdirSync(tmp, { recursive: true });

process.env['ORACLE_STATE_DB_PATH'] = DB;

type GetRecentFn         = (testName: string, errorHash: string, lookback?: number) => RecentFailurePattern | undefined;
type SaveRunFn           = (pipelineId: string, totalFailures: number, results: never[], verdict: 'CLEAR' | 'BLOCKED') => number;
type SaveActionFn        = (runId: number, proposal: ActionProposal, decision: Decision) => boolean;
type RecordExecFn        = (runId: number, fingerprint: string, exec: { ok: boolean; detail: string; timestamp: string }) => void;
type GetPatternFn        = (testName: string, errorHash: string, options?: { includeClusterScoped?: boolean }) => PatternStats;
type GetClusterHistoryFn = (clusterKey: string) => PatternStats;

let getRecentFailurePattern: GetRecentFn         | null = null;
let saveRun:                 SaveRunFn           | null = null;
let saveAction:              SaveActionFn        | null = null;
let recordActionExecution:   RecordExecFn        | null = null;
let getPatternStats:         GetPatternFn        | null = null;
let getClusterHistoryStats:  GetClusterHistoryFn | null = null;
let getDb: (() => import('better-sqlite3').Database) | null = null;
let dbAvailable = false;

try {
  const store = await import('../src/state-store.js');
  store.initDb();
  getRecentFailurePattern = store.getRecentFailurePattern;
  saveRun                 = store.saveRun;
  saveAction              = store.saveAction;
  recordActionExecution   = store.recordActionExecution;
  getPatternStats         = store.getPatternStats;
  getClusterHistoryStats  = store.getClusterHistoryStats;
  getDb                   = store.getDb;
  dbAvailable             = true;
} catch {
  console.warn('[test] better-sqlite3 unavailable on this Node version — DB tests skipped');
}

const describeMaybe = dbAvailable ? describe : describe.skip;

after(() => rmSync(tmp, { recursive: true, force: true }));

// ── helpers ────────────────────────────────────────────────────────────────────

function insertFailure(runId: number, testName: string, errorHash: string, category: string): void {
  getDb!().prepare(
    `INSERT INTO failures (run_id, test_name, error_hash, category, confidence)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(runId, testName, errorHash, category, 0.9);
}

function makeRun(): number {
  return saveRun!('pipe-test', 0, [], 'CLEAR');
}

// ── tests ──────────────────────────────────────────────────────────────────────

describeMaybe('getRecentFailurePattern', () => {
  it('returns undefined when no failures exist for test+hash', () => {
    assert.strictEqual(getRecentFailurePattern!('no-such-test', 'no-such-hash'), undefined);
  });

  it('returns all three fields for a single occurrence', () => {
    const runId = makeRun();
    insertFailure(runId, 'test-single', 'hash-single', 'FLAKY');

    const result = getRecentFailurePattern!('test-single', 'hash-single');
    assert.ok(result !== undefined);
    assert.strictEqual(result.totalCount, 1);
    assert.strictEqual(result.dominantCategory, 'FLAKY');
    assert.strictEqual(result.dominantCategoryCount, 1);
  });

  it('does NOT match when test_name differs (hash alone is not the key)', () => {
    const runId = makeRun();
    // Insert under 'test-name-a', query with 'test-name-b' — same hash, different test.
    insertFailure(runId, 'test-name-a', 'hash-shared', 'REGRESSION');
    const result = getRecentFailurePattern!('test-name-b', 'hash-shared');
    assert.strictEqual(result, undefined, 'different test_name must not match');
  });

  it('totalCount is total occurrences in window, dominantCategoryCount is just that category', () => {
    const runId = makeRun();
    const hash  = 'hash-mixed';
    const test  = 'test-mixed';
    // 3 REGRESSION + 2 FLAKY = 5 total; REGRESSION dominates
    for (let i = 0; i < 3; i++) insertFailure(runId, test, hash, 'REGRESSION');
    for (let i = 0; i < 2; i++) insertFailure(runId, test, hash, 'FLAKY');

    const result = getRecentFailurePattern!(test, hash, 20);
    assert.ok(result !== undefined);
    assert.strictEqual(result.totalCount, 5, 'totalCount = all rows in window');
    assert.strictEqual(result.dominantCategory, 'REGRESSION');
    assert.strictEqual(result.dominantCategoryCount, 3, 'dominantCategoryCount = only dominant rows');
  });

  it('applies the lookback window — totalCount reflects the window, not all-time', () => {
    const runId = makeRun();
    const hash  = 'hash-lookback';
    const test  = 'test-lookback';

    // 5 old REGRESSION, then 2 new FLAKY. With lookback=3: window has 2 FLAKY + 1 REGRESSION.
    for (let i = 0; i < 5; i++) insertFailure(runId, test, hash, 'REGRESSION');
    for (let i = 0; i < 2; i++) insertFailure(runId, test, hash, 'FLAKY');

    const result = getRecentFailurePattern!(test, hash, 3);
    assert.ok(result !== undefined);
    assert.strictEqual(result.totalCount, 3, 'totalCount = window size, not all-time');
    assert.strictEqual(result.dominantCategory, 'FLAKY', 'most-recent category wins');
    assert.strictEqual(result.dominantCategoryCount, 2);
  });

  it('respects lookback=1 — returns only the most recent row', () => {
    const runId = makeRun();
    const hash  = 'hash-lb1';
    const test  = 'test-lb1';
    insertFailure(runId, test, hash, 'REGRESSION');
    insertFailure(runId, test, hash, 'FLAKY');

    const result = getRecentFailurePattern!(test, hash, 1);
    assert.ok(result !== undefined);
    assert.strictEqual(result.totalCount, 1);
    assert.strictEqual(result.dominantCategory, 'FLAKY');
  });

  it('does NOT count all-time history when lookback is smaller', () => {
    const runId = makeRun();
    const hash  = 'hash-alltime';
    const test  = 'test-alltime';
    for (let i = 0; i < 10; i++) insertFailure(runId, test, hash, 'REGRESSION');
    insertFailure(runId, test, hash, 'FLAKY');
    insertFailure(runId, test, hash, 'FLAKY');

    const result = getRecentFailurePattern!(test, hash, 2);
    assert.ok(result !== undefined);
    assert.strictEqual(result.totalCount, 2, 'must reflect lookback window, not all-time total');
    assert.strictEqual(result.dominantCategory, 'FLAKY');
  });
});

// ── getPatternStats — cluster-aware history ───────────────────────────────────
//
// Cluster-scoped create_jira actions persist scopeId = <clusterKey>, NOT
// "<testName>:<errorHash>". Before this fix, getPatternStats only looked at
// the per-failure scopeId, so the cluster Jira created for a cluster that
// contained this failure was invisible to future suppression decisions.
//
// These tests pin the contract: cluster actions count toward per-member
// history via payload_json.clusterMembers[].

describeMaybe('getPatternStats — cluster-aware history', () => {
  function clusterJiraProposal(
    runId:      number,
    clusterKey: string,
    members:    Array<{ testName: string; errorHash: string }>,
  ): ActionProposal {
    return {
      type:        'create_jira',
      scope:       'cluster',
      scopeId:     clusterKey,
      failureId:   null,
      clusterKey,
      runId,
      pipelineId:     'pipe-pattern-test',
      source:         'policy',
      fingerprint:    `fp-${clusterKey}`,
      clusterMembers: members,
    };
  }

  const approved = (proposal: ActionProposal): Decision => ({
    proposal, verdict: 'approved', confidence: 0.9, reason: 'policy:auto-approved',
  });

  it('credits a cluster Jira execution to every one of its members', () => {
    const runId = saveRun!('pipe-cluster-hist', 0, [], 'CLEAR');
    const members = [
      { testName: 'Checkout > test A', errorHash: 'hA' },
      { testName: 'Checkout > test B', errorHash: 'hB' },
      { testName: 'Checkout > test C', errorHash: 'hC' },
    ];
    const proposal = clusterJiraProposal(runId, 'regression:http_404:checkout', members);

    assert.ok(saveAction!(runId, proposal, approved(proposal)), 'cluster action should insert');
    recordActionExecution!(runId, proposal.fingerprint, {
      ok: true, detail: 'created QA-999', timestamp: new Date().toISOString(),
    });

    for (const m of members) {
      const stats = getPatternStats!(m.testName, m.errorHash);
      assert.equal(stats.actionCount,      1, `${m.testName} should see the cluster action`);
      assert.equal(stats.jiraCreatedCount, 1, `${m.testName} should see the cluster Jira creation`);
    }
  });

  it('failures outside the cluster see nothing from that cluster action', () => {
    const runId = saveRun!('pipe-cluster-outside', 0, [], 'CLEAR');
    const proposal = clusterJiraProposal(runId, 'regression:http_404:login', [
      { testName: 'Login > test A', errorHash: 'la' },
    ]);
    saveAction!(runId, proposal, approved(proposal));
    recordActionExecution!(runId, proposal.fingerprint, {
      ok: true, detail: 'created QA-1000', timestamp: new Date().toISOString(),
    });

    const unrelated = getPatternStats!('Checkout > unrelated', 'hZ');
    assert.equal(unrelated.actionCount,      0);
    assert.equal(unrelated.jiraCreatedCount, 0);
  });

  it('failed cluster Jira executions do NOT count as createdCount', () => {
    const runId = saveRun!('pipe-cluster-fail', 0, [], 'CLEAR');
    const members = [{ testName: 'X', errorHash: 'xh' }];
    const proposal = clusterJiraProposal(runId, 'regression:http_404:x', members);
    saveAction!(runId, proposal, approved(proposal));
    recordActionExecution!(runId, proposal.fingerprint, {
      ok: false, detail: 'jira api 500', timestamp: new Date().toISOString(),
    });

    const stats = getPatternStats!('X', 'xh');
    assert.equal(stats.actionCount,      1, 'proposal still counted in actionCount');
    assert.equal(stats.jiraCreatedCount, 0, 'but failed exec must not bump jiraCreatedCount');
  });
});

// ── getPatternStats — per-failure-only mode ───────────────────────────────────
//
// The cluster-aware fix surfaces cluster Jiras to every member. When the
// aggregator then sums across N members it multiplies one cluster Jira by
// N. `includeClusterScoped: false` gives the aggregator a stream that
// deliberately excludes cluster rows so cluster-level history can be added
// once via getClusterHistoryStats without double-counting.

describeMaybe('getPatternStats — includeClusterScoped: false', () => {
  function clusterProposal(
    runId:      number,
    clusterKey: string,
    members:    Array<{ testName: string; errorHash: string }>,
  ): ActionProposal {
    return {
      type:        'create_jira',
      scope:       'cluster',
      scopeId:     clusterKey,
      failureId:   null,
      clusterKey,
      runId,
      pipelineId:     'pipe-per-failure',
      source:         'policy',
      fingerprint:    `fp-pf-${clusterKey}`,
      clusterMembers: members,
    };
  }
  const approved = (proposal: ActionProposal): Decision => ({
    proposal, verdict: 'approved', confidence: 0.9, reason: 'policy:auto-approved',
  });

  it('hides cluster-scoped rows that cluster-aware mode would surface', () => {
    const runId = saveRun!('pipe-per-failure-hide', 0, [], 'CLEAR');
    const members = [
      { testName: 'PF > a', errorHash: 'ph1' },
      { testName: 'PF > b', errorHash: 'ph2' },
    ];
    const proposal = clusterProposal(runId, 'regression:http_404:pf', members);
    saveAction!(runId, proposal, approved(proposal));
    recordActionExecution!(runId, proposal.fingerprint, {
      ok: true, detail: 'created QA-9001', timestamp: new Date().toISOString(),
    });

    // Default (cluster-aware) — member sees the cluster Jira.
    const awareStats = getPatternStats!('PF > a', 'ph1');
    assert.equal(awareStats.actionCount,      1);
    assert.equal(awareStats.jiraCreatedCount, 1);

    // Per-failure-only — member does NOT see the cluster Jira.
    const perFailureStats = getPatternStats!('PF > a', 'ph1', { includeClusterScoped: false });
    assert.equal(perFailureStats.actionCount,      0, 'per-failure-only must exclude cluster rows');
    assert.equal(perFailureStats.jiraCreatedCount, 0);
  });

  it('still counts per-failure rows scoped exactly to this test+hash', () => {
    const runId = saveRun!('pipe-per-failure-exact', 0, [], 'CLEAR');
    // A per-failure-scoped action — scopeId = "<test>:<hash>".
    const perFailureProposal: ActionProposal = {
      type:        'create_jira',
      scope:       'failure',
      scopeId:     'PF > exact:exh',
      failureId:   null,
      clusterKey:  null,
      runId,
      pipelineId:  'pipe-per-failure-exact',
      source:      'policy',
      fingerprint: 'fp-pf-exact',
    };
    saveAction!(runId, perFailureProposal, approved(perFailureProposal));
    recordActionExecution!(runId, perFailureProposal.fingerprint, {
      ok: true, detail: 'created QA-9002', timestamp: new Date().toISOString(),
    });

    const stats = getPatternStats!('PF > exact', 'exh', { includeClusterScoped: false });
    assert.equal(stats.actionCount,      1, 'per-failure rows must still be counted');
    assert.equal(stats.jiraCreatedCount, 1);
  });
});

// ── getClusterHistoryStats — cluster-key-scoped history ───────────────────────
//
// Returns stats for actions whose scopeId = clusterKey. Intended for
// aggregateClusterStats to add cluster-level history exactly once after
// summing per-failure-only stats across cluster members.

describeMaybe('getClusterHistoryStats', () => {
  function clusterProposal(
    runId:      number,
    clusterKey: string,
    fingerprint: string,
    members:    Array<{ testName: string; errorHash: string }>,
  ): ActionProposal {
    return {
      type:        'create_jira',
      scope:       'cluster',
      scopeId:     clusterKey,
      failureId:   null,
      clusterKey,
      runId,
      pipelineId:     'pipe-cluster-history',
      source:         'policy',
      fingerprint,
      clusterMembers: members,
    };
  }
  const approved = (proposal: ActionProposal): Decision => ({
    proposal, verdict: 'approved', confidence: 0.9, reason: 'policy:auto-approved',
  });

  it('returns zeros when the cluster has no prior history', () => {
    const stats = getClusterHistoryStats!('regression:http_404:nonexistent');
    assert.equal(stats.actionCount,      0);
    assert.equal(stats.jiraCreatedCount, 0);
    assert.equal(stats.jiraDuplicateCount, 0);
  });

  it('surfaces one cluster action as count=1 regardless of member count', () => {
    const runId = saveRun!('pipe-cluster-once', 0, [], 'CLEAR');
    const clusterKey = 'regression:http_404:once';
    const members = [
      { testName: 'T1', errorHash: 'h1' },
      { testName: 'T2', errorHash: 'h2' },
      { testName: 'T3', errorHash: 'h3' },
    ];
    const proposal = clusterProposal(runId, clusterKey, `fp-once-${clusterKey}`, members);
    saveAction!(runId, proposal, approved(proposal));
    recordActionExecution!(runId, proposal.fingerprint, {
      ok: true, detail: 'created QA-7001', timestamp: new Date().toISOString(),
    });

    const stats = getClusterHistoryStats!(clusterKey);
    assert.equal(stats.actionCount,      1, '3-member cluster Jira still counts as 1 cluster row');
    assert.equal(stats.jiraCreatedCount, 1);
  });

  it('failed cluster Jira execution does NOT bump jiraCreatedCount', () => {
    const runId = saveRun!('pipe-cluster-fail-hist', 0, [], 'CLEAR');
    const clusterKey = 'regression:http_404:fail';
    const proposal = clusterProposal(runId, clusterKey, 'fp-fail-cluster-hist', [
      { testName: 'TF', errorHash: 'fh' },
    ]);
    saveAction!(runId, proposal, approved(proposal));
    recordActionExecution!(runId, proposal.fingerprint, {
      ok: false, detail: 'jira api 500', timestamp: new Date().toISOString(),
    });

    const stats = getClusterHistoryStats!(clusterKey);
    assert.equal(stats.actionCount,      1, 'proposal still counted');
    assert.equal(stats.jiraCreatedCount, 0, 'failed exec must not bump createdCount');
  });

  it('does not pick up per-failure rows (scope separation)', () => {
    const runId = saveRun!('pipe-cluster-scope-split', 0, [], 'CLEAR');
    // A per-failure proposal whose scopeId happens to look distinct from any
    // clusterKey. getClusterHistoryStats must not match it.
    const perFailureProposal: ActionProposal = {
      type:        'create_jira',
      scope:       'failure',
      scopeId:     'SomeTest:someHash',
      failureId:   null,
      clusterKey:  null,
      runId,
      pipelineId:  'pipe-cluster-scope-split',
      source:      'policy',
      fingerprint: 'fp-scope-split',
    };
    saveAction!(runId, perFailureProposal, approved(perFailureProposal));
    recordActionExecution!(runId, perFailureProposal.fingerprint, {
      ok: true, detail: 'created QA-7002', timestamp: new Date().toISOString(),
    });

    // Querying with that same scopeId as a "clusterKey" would technically
    // match (it's just a string), so we query a DIFFERENT key to prove
    // separation — nothing matches.
    const stats = getClusterHistoryStats!('regression:http_404:unrelated');
    assert.equal(stats.actionCount,      0, 'per-failure rows must not leak into unrelated clusterKey stats');
    assert.equal(stats.jiraCreatedCount, 0);
  });
});
