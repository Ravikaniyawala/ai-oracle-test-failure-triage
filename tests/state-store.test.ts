import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { RecentFailurePattern } from '../src/types.js';

const tmp = join(tmpdir(), 'oracle-state-store-test');
const DB  = join(tmp, 'test-state.db');
mkdirSync(tmp, { recursive: true });

process.env['ORACLE_STATE_DB_PATH'] = DB;

type GetRecentFn = (testName: string, errorHash: string, lookback?: number) => RecentFailurePattern | undefined;
type SaveRunFn   = (pipelineId: string, totalFailures: number, results: never[], verdict: 'CLEAR' | 'BLOCKED') => number;

let getRecentFailurePattern: GetRecentFn | null = null;
let saveRun: SaveRunFn | null = null;
let getDb: (() => import('better-sqlite3').Database) | null = null;
let dbAvailable = false;

try {
  const store = await import('../src/state-store.js');
  store.initDb();
  getRecentFailurePattern = store.getRecentFailurePattern;
  saveRun                 = store.saveRun;
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
