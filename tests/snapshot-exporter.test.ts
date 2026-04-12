import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { exportSnapshot, SNAPSHOT_SCHEMA_VERSION } from '../src/snapshot-exporter.js';
import type { RepoIdentity } from '../src/repo-identity.js';
import type { TriageResult } from '../src/types.js';
import { TriageCategory, ReportFormat } from '../src/types.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const IDENTITY: RepoIdentity = {
  repoId:          'repo-123',
  repoName:        'my-org/my-repo',
  repoDisplayName: 'my-repo',
};

const RUN_ID    = 'run-abc-001';
const TIMESTAMP = '2026-04-12T10:00:00.000Z';

function makeResult(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    testName:     'SomeTest.someMethod',
    errorMessage: 'Expected 200 but got 404',
    errorHash:    'abc123',
    file:         'tests/SomeTest.java',
    duration:     1500,
    retries:      0,
    category:     TriageCategory.REGRESSION,
    confidence:   0.9,
    reasoning:    'The endpoint no longer exists',
    suggestedFix: 'Restore the endpoint',
    ...overrides,
  };
}

// ── Temp directory management ─────────────────────────────────────────────────

let tmpDir:      string;
let snapshotDir: string;
let fakeDbPath:  string;

before(() => {
  tmpDir      = mkdtempSync(path.join(tmpdir(), 'oracle-snapshot-test-'));
  snapshotDir = path.join(tmpDir, 'snapshots');
  fakeDbPath  = path.join(tmpDir, 'oracle-state.db');
  // Create a real (empty) SQLite DB so VACUUM INTO succeeds.
  // A raw text file is rejected by VACUUM INTO with SQLITE_NOTADB.
  const db = new Database(fakeDbPath);
  db.exec('CREATE TABLE IF NOT EXISTS _init (id INTEGER PRIMARY KEY)');
  db.close();
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('exportSnapshot', () => {
  it('creates the correct directory structure', () => {
    exportSnapshot({
      snapshotRoot: snapshotDir,
      identity:     IDENTITY,
      runId:        RUN_ID,
      timestamp:    TIMESTAMP,
      verdict:      'CLEAR',
      results:      [],
      dbSourcePath: fakeDbPath,
    });

    const repoDir   = path.join(snapshotDir, 'repos', IDENTITY.repoId);
    const eventsDir = path.join(repoDir, 'events');

    assert.ok(existsSync(repoDir),   'repo dir should exist');
    assert.ok(existsSync(eventsDir), 'events dir should exist');
    assert.ok(existsSync(path.join(repoDir, 'manifest.json')), 'manifest.json should exist');
    assert.ok(existsSync(path.join(repoDir, 'latest.db')),     'latest.db should exist');
    assert.ok(existsSync(path.join(eventsDir, `${RUN_ID}.json`)), 'event JSON should exist');
  });

  it('event JSON has correct fields and schema_version=1', () => {
    const runId = 'run-event-fields-check';
    const results = [
      makeResult({ category: TriageCategory.FLAKY,      confidence: 0.8, errorHash: 'h1' }),
      makeResult({ category: TriageCategory.REGRESSION, confidence: 0.9, errorHash: 'h2' }),
    ];

    exportSnapshot({
      snapshotRoot: snapshotDir,
      identity:     IDENTITY,
      runId,
      timestamp:    TIMESTAMP,
      verdict:      'BLOCKED',
      results,
      dbSourcePath: fakeDbPath,
    });

    const eventsDir = path.join(snapshotDir, 'repos', IDENTITY.repoId, 'events');
    const event     = JSON.parse(readFileSync(path.join(eventsDir, `${runId}.json`), 'utf8'));

    assert.equal(event.schema_version,    SNAPSHOT_SCHEMA_VERSION);
    assert.equal(event.repo_id,           IDENTITY.repoId);
    assert.equal(event.repo_name,         IDENTITY.repoName);
    assert.equal(event.repo_display_name, IDENTITY.repoDisplayName);
    assert.equal(event.run_id,            runId);
    assert.equal(event.timestamp,         TIMESTAMP);
    assert.equal(event.verdict,           'BLOCKED');
  });

  it('manifest.json has correct fields', () => {
    const runId = 'run-manifest-check';
    exportSnapshot({
      snapshotRoot: snapshotDir,
      identity:     IDENTITY,
      runId,
      timestamp:    TIMESTAMP,
      verdict:      'CLEAR',
      results:      [],
      dbSourcePath: fakeDbPath,
    });

    const manifest = JSON.parse(
      readFileSync(path.join(snapshotDir, 'repos', IDENTITY.repoId, 'manifest.json'), 'utf8'),
    );

    assert.equal(manifest.schema_version,    SNAPSHOT_SCHEMA_VERSION);
    assert.equal(manifest.repo_id,           IDENTITY.repoId);
    assert.equal(manifest.repo_name,         IDENTITY.repoName);
    assert.equal(manifest.repo_display_name, IDENTITY.repoDisplayName);
    assert.equal(manifest.updated_at,        TIMESTAMP);
    assert.equal(manifest.latest_run_id,     runId);
    assert.equal(manifest.latest_verdict,    'CLEAR');
    assert.equal(manifest.db_key,            `repos/${IDENTITY.repoId}/latest.db`);
  });

  it('latest.db is a valid, openable SQLite database', () => {
    // VACUUM INTO produces a compacted snapshot — it is not byte-identical
    // to the source, but it must be a well-formed SQLite file that can be
    // opened and queried.
    const runId = 'run-db-copy-check';
    exportSnapshot({
      snapshotRoot: snapshotDir,
      identity:     IDENTITY,
      runId,
      timestamp:    TIMESTAMP,
      verdict:      'CLEAR',
      results:      [],
      dbSourcePath: fakeDbPath,
    });

    const destPath = path.join(snapshotDir, 'repos', IDENTITY.repoId, 'latest.db');
    assert.ok(existsSync(destPath), 'latest.db should exist');

    // Open read-only and confirm it is a valid SQLite database
    const db = new Database(destPath, { readonly: true });
    try {
      const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      assert.ok(Array.isArray(result), 'should be able to query the copied DB');
    } finally {
      db.close();
    }
  });

  it('CLEAR run exports correctly with empty failures array', () => {
    const runId = 'run-clear-empty';
    exportSnapshot({
      snapshotRoot: snapshotDir,
      identity:     IDENTITY,
      runId,
      timestamp:    TIMESTAMP,
      verdict:      'CLEAR',
      results:      [],
      dbSourcePath: fakeDbPath,
    });

    const eventsDir = path.join(snapshotDir, 'repos', IDENTITY.repoId, 'events');
    const event     = JSON.parse(readFileSync(path.join(eventsDir, `${runId}.json`), 'utf8'));

    assert.equal(event.verdict,          'CLEAR');
    assert.deepEqual(event.failures,     []);
    assert.equal(event.FLAKY,            0);
    assert.equal(event.REGRESSION,       0);
    assert.equal(event.NEW_BUG,          0);
    assert.equal(event.ENV_ISSUE,        0);
  });

  it('category counts are accurate', () => {
    const runId  = 'run-category-counts';
    const results = [
      makeResult({ category: TriageCategory.FLAKY,      errorHash: 'f1' }),
      makeResult({ category: TriageCategory.FLAKY,      errorHash: 'f2' }),
      makeResult({ category: TriageCategory.REGRESSION, errorHash: 'r1' }),
      makeResult({ category: TriageCategory.NEW_BUG,    errorHash: 'n1' }),
    ];

    exportSnapshot({
      snapshotRoot: snapshotDir,
      identity:     IDENTITY,
      runId,
      timestamp:    TIMESTAMP,
      verdict:      'BLOCKED',
      results,
      dbSourcePath: fakeDbPath,
    });

    const eventsDir = path.join(snapshotDir, 'repos', IDENTITY.repoId, 'events');
    const event     = JSON.parse(readFileSync(path.join(eventsDir, `${runId}.json`), 'utf8'));

    assert.equal(event.FLAKY,      2);
    assert.equal(event.REGRESSION, 1);
    assert.equal(event.NEW_BUG,    1);
    assert.equal(event.ENV_ISSUE,  0);
  });

  it('failure summaries contain only test_name, error_hash, category, confidence', () => {
    const runId  = 'run-failure-summary-fields';
    const result = makeResult({
      testName:     'TestFoo.bar',
      errorHash:    'hash-xyz',
      category:     TriageCategory.REGRESSION,
      confidence:   0.95,
      errorMessage: 'Should NOT appear in snapshot',
      reasoning:    'Should NOT appear in snapshot',
      suggestedFix: 'Should NOT appear in snapshot',
    });

    exportSnapshot({
      snapshotRoot: snapshotDir,
      identity:     IDENTITY,
      runId,
      timestamp:    TIMESTAMP,
      verdict:      'BLOCKED',
      results:      [result],
      dbSourcePath: fakeDbPath,
    });

    const eventsDir = path.join(snapshotDir, 'repos', IDENTITY.repoId, 'events');
    const event     = JSON.parse(readFileSync(path.join(eventsDir, `${runId}.json`), 'utf8'));

    assert.equal(event.failures.length, 1);
    const f = event.failures[0];

    // Only these 4 keys should be present
    assert.deepEqual(Object.keys(f).sort(), ['category', 'confidence', 'error_hash', 'test_name'].sort());
    assert.equal(f.test_name,  'TestFoo.bar');
    assert.equal(f.error_hash, 'hash-xyz');
    assert.equal(f.category,   'REGRESSION');
    assert.equal(f.confidence,  0.95);

    // Raw fields must NOT appear
    assert.equal('errorMessage' in f, false);
    assert.equal('reasoning'    in f, false);
    assert.equal('suggestedFix' in f, false);
  });

  it('throws when dbSourcePath does not exist (so caller can catch)', () => {
    assert.throws(() => {
      exportSnapshot({
        snapshotRoot: snapshotDir,
        identity:     IDENTITY,
        runId:        'run-missing-db',
        timestamp:    TIMESTAMP,
        verdict:      'CLEAR',
        results:      [],
        dbSourcePath: path.join(tmpDir, 'nonexistent.db'),
      });
    });
  });

  it('overwrites manifest on second run with updated latest_run_id', () => {
    const runId1 = 'run-overwrite-first';
    const runId2 = 'run-overwrite-second';

    exportSnapshot({
      snapshotRoot: snapshotDir,
      identity:     IDENTITY,
      runId:        runId1,
      timestamp:    TIMESTAMP,
      verdict:      'CLEAR',
      results:      [],
      dbSourcePath: fakeDbPath,
    });

    exportSnapshot({
      snapshotRoot: snapshotDir,
      identity:     IDENTITY,
      runId:        runId2,
      timestamp:    '2026-04-12T11:00:00.000Z',
      verdict:      'BLOCKED',
      results:      [makeResult()],
      dbSourcePath: fakeDbPath,
    });

    const manifest = JSON.parse(
      readFileSync(path.join(snapshotDir, 'repos', IDENTITY.repoId, 'manifest.json'), 'utf8'),
    );

    assert.equal(manifest.latest_run_id,  runId2);
    assert.equal(manifest.latest_verdict, 'BLOCKED');
    assert.equal(manifest.updated_at,     '2026-04-12T11:00:00.000Z');
  });
});
