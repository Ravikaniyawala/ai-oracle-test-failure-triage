/**
 * Tests for scripts/export-eval-dataset.ts and scripts/score-eval-dataset.ts
 *
 * Uses small synthetic SQLite fixtures — no real DB, no network calls.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

import {
  exportEvalCases,
  SCHEMA_VERSION,
  type EvalCase,
} from '../scripts/export-eval-dataset.js';

import {
  scoreEvalCases,
  formatMetrics,
} from '../scripts/score-eval-dataset.js';

// ── DB fixture helpers ────────────────────────────────────────────────────────

function createFixtureDb(dirPath: string): Database.Database {
  const db = new Database(join(dirPath, 'fixture.db'));

  db.exec(`
    CREATE TABLE runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       TEXT NOT NULL,
      pipeline_id     TEXT NOT NULL,
      total_failures  INTEGER NOT NULL,
      categories_json TEXT NOT NULL,
      verdict         TEXT NOT NULL DEFAULT 'BLOCKED',
      repo_id         TEXT,
      repo_name       TEXT,
      repo_display_name TEXT
    );
    CREATE TABLE failures (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     INTEGER NOT NULL,
      test_name  TEXT NOT NULL,
      error_hash TEXT NOT NULL,
      category   TEXT NOT NULL,
      confidence REAL NOT NULL,
      fix_applied INTEGER DEFAULT 0
    );
    CREATE TABLE feedback (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      feedback_type      TEXT NOT NULL,
      pipeline_id        TEXT,
      test_name          TEXT,
      error_hash         TEXT,
      action_fingerprint TEXT,
      old_value          TEXT,
      new_value          TEXT,
      notes              TEXT,
      created_at         TEXT NOT NULL
    );
  `);

  return db;
}

function insertRun(
  db:           Database.Database,
  pipelineId:   string,
  repoId:       string | null = 'repo-123',
  repoName:     string | null = 'org/repo',
): number {
  const stmt = db.prepare(
    `INSERT INTO runs (timestamp, pipeline_id, total_failures, categories_json, verdict, repo_id, repo_name)
     VALUES (?, ?, 1, '{}', 'BLOCKED', ?, ?)`,
  );
  return (stmt.run('2026-04-01T10:00:00.000Z', pipelineId, repoId, repoName).lastInsertRowid as number);
}

function insertFailure(
  db:        Database.Database,
  runId:     number,
  testName:  string,
  errorHash: string,
  category:  string,
  confidence = 0.85,
): number {
  const stmt = db.prepare(
    `INSERT INTO failures (run_id, test_name, error_hash, category, confidence)
     VALUES (?, ?, ?, ?, ?)`,
  );
  return (stmt.run(runId, testName, errorHash, category, confidence).lastInsertRowid as number);
}

function insertFeedback(
  db:           Database.Database,
  feedbackType: string,
  testName:     string | null,
  errorHash:    string | null,
  oldValue:     string | null = null,
  newValue:     string | null = null,
  pipelineId:   string | null = null,
): void {
  db.prepare(
    `INSERT INTO feedback (feedback_type, pipeline_id, test_name, error_hash, old_value, new_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '2026-04-02T12:00:00.000Z')`,
  ).run(feedbackType, pipelineId, testName, errorHash, oldValue, newValue);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: export
// ─────────────────────────────────────────────────────────────────────────────

describe('eval export — classification_corrected', () => {
  let tmpDir!: string;
  let db!:     Database.Database;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'oracle-eval-test-'));
    db     = createFixtureDb(tmpDir);
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports valid classification_corrected row as high-quality case', () => {
    const runId = insertRun(db, 'pipe-cc-1');
    insertFailure(db, runId, 'Suite > login test', 'hash001', 'FLAKY', 0.75);
    insertFeedback(db, 'classification_corrected', 'Suite > login test', 'hash001', 'FLAKY', 'REGRESSION', 'pipe-cc-1');

    const { cases, summary } = exportEvalCases(db);
    const c = cases.find(x => x.error_hash === 'hash001' && x.evidence_source === 'classification_corrected');

    assert.ok(c, 'should export the classification_corrected case');
    assert.equal(c.schema_version,         SCHEMA_VERSION);
    assert.equal(c.predicted_category,     'FLAKY');
    assert.equal(c.predicted_should_block, false);
    assert.equal(c.gold_category,          'REGRESSION');
    assert.equal(c.gold_should_block,      true,  'REGRESSION should block');
    assert.equal(c.label_quality,          'high');
    assert.equal(c.repo_id,                'repo-123');
    assert.equal(c.repo_name,              'org/repo');
    assert.equal(summary.exportedCases,    1);
  });

  it('skips classification_corrected with invalid new_value category', () => {
    const runId = insertRun(db, 'pipe-cc-invalid');
    insertFailure(db, runId, 'Suite > bad test', 'hash002', 'FLAKY');
    insertFeedback(db, 'classification_corrected', 'Suite > bad test', 'hash002', 'FLAKY', 'NOT_A_CATEGORY', 'pipe-cc-invalid');

    const { cases, summary } = exportEvalCases(db);
    const c = cases.find(x => x.error_hash === 'hash002');
    assert.ok(!c, 'invalid category should be skipped');
    assert.ok((summary.skipReasons['classification_corrected:invalid_new_category'] ?? 0) >= 1);
  });

  it('skips classification_corrected with no matching failure row', () => {
    insertFeedback(db, 'classification_corrected', 'Suite > orphan test', 'hash_no_failure', 'FLAKY', 'REGRESSION', 'pipe-orphan');

    const { summary } = exportEvalCases(db);
    assert.ok((summary.skipReasons['classification_corrected:no_matching_failure'] ?? 0) >= 1);
  });

  it('skips classification_corrected with null test_name', () => {
    insertFeedback(db, 'classification_corrected', null, 'hash003', 'FLAKY', 'REGRESSION', 'pipe-null');
    const { summary } = exportEvalCases(db);
    assert.ok((summary.skipReasons['classification_corrected:missing_test_or_hash'] ?? 0) >= 1);
  });

  it('skips when unanchored and same test+hash produced different categories across runs', () => {
    // Two runs, same test+hash, different Oracle categories — ambiguous without pipeline anchor
    const run1 = insertRun(db, 'pipe-amb-1');
    const run2 = insertRun(db, 'pipe-amb-2');
    insertFailure(db, run1, 'Suite > ambiguous test', 'hashAMB', 'FLAKY',      0.7);
    insertFailure(db, run2, 'Suite > ambiguous test', 'hashAMB', 'REGRESSION', 0.9);
    // Feedback with no pipeline_id — cannot anchor
    insertFeedback(db, 'classification_corrected', 'Suite > ambiguous test', 'hashAMB',
                   'FLAKY', 'REGRESSION', null);

    const { summary } = exportEvalCases(db);
    assert.ok((summary.skipReasons['classification_corrected:no_matching_failure'] ?? 0) >= 1,
      'ambiguous unanchored lookup should be skipped');
  });
});

describe('eval export — retry_passed', () => {
  let tmpDir!: string;
  let db!:     Database.Database;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'oracle-eval-test-'));
    db     = createFixtureDb(tmpDir);
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports retry_passed as gold_category=FLAKY, gold_should_block=false', () => {
    const runId = insertRun(db, 'pipe-rp-1');
    insertFailure(db, runId, 'Suite > flaky test', 'hash010', 'REGRESSION', 0.9);
    insertFeedback(db, 'retry_passed', 'Suite > flaky test', 'hash010', null, null, 'pipe-rp-1');

    const { cases } = exportEvalCases(db);
    const c = cases.find(x => x.error_hash === 'hash010');

    assert.ok(c, 'retry_passed case should be exported');
    assert.equal(c.gold_category,      'FLAKY');
    assert.equal(c.gold_should_block,  false);
    assert.equal(c.label_quality,      'high');
    // Predicted was REGRESSION — Oracle was wrong about this one
    assert.equal(c.predicted_category,     'REGRESSION');
    assert.equal(c.predicted_should_block, true);
  });

  it('skips retry_passed with null test_name', () => {
    insertFeedback(db, 'retry_passed', null, 'hash011', null, null, 'pipe-rp-null');
    const { summary } = exportEvalCases(db);
    assert.ok((summary.skipReasons['retry_passed:missing_test_or_hash'] ?? 0) >= 1);
  });
});

describe('eval export — jira_closed_confirmed', () => {
  let tmpDir!: string;
  let db!:     Database.Database;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'oracle-eval-test-'));
    db     = createFixtureDb(tmpDir);
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips jira_closed_confirmed when min-quality is high (default)', () => {
    const runId = insertRun(db, 'pipe-jcc-1');
    insertFailure(db, runId, 'Suite > confirmed test', 'hash020', 'REGRESSION', 0.9);
    insertFeedback(db, 'jira_closed_confirmed', 'Suite > confirmed test', 'hash020', null, null, 'pipe-jcc-1');

    const { cases, summary } = exportEvalCases(db, 'high');
    const c = cases.find(x => x.error_hash === 'hash020');
    assert.ok(!c, 'jira_closed_confirmed should be skipped at min-quality=high');
    assert.ok((summary.skipReasons['jira_closed_confirmed:quality_below_minimum'] ?? 0) >= 1);
  });

  it('exports jira_closed_confirmed as medium-quality when min-quality=medium', () => {
    const runId = insertRun(db, 'pipe-jcc-2');
    insertFailure(db, runId, 'Suite > medium test', 'hash021', 'NEW_BUG', 0.85);
    insertFeedback(db, 'jira_closed_confirmed', 'Suite > medium test', 'hash021', null, null, 'pipe-jcc-2');

    const { cases } = exportEvalCases(db, 'medium');
    const c = cases.find(x => x.error_hash === 'hash021');
    assert.ok(c, 'jira_closed_confirmed should export at min-quality=medium');
    assert.equal(c.gold_category,     null,  'no category info from jira_closed_confirmed');
    assert.equal(c.gold_should_block, true);
    assert.equal(c.label_quality,     'medium');
  });
});

describe('eval export — excluded feedback types', () => {
  let tmpDir!: string;
  let db!:     Database.Database;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'oracle-eval-test-'));
    db     = createFixtureDb(tmpDir);
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips retry_failed, jira_closed_duplicate, action_overridden', () => {
    const runId = insertRun(db, 'pipe-excl-1');
    insertFailure(db, runId, 'Suite > excl test', 'hash030', 'REGRESSION');
    insertFeedback(db, 'retry_failed',          'Suite > excl test', 'hash030', null, null, 'pipe-excl-1');
    insertFeedback(db, 'jira_closed_duplicate', 'Suite > excl test', 'hash030', null, null, 'pipe-excl-1');
    insertFeedback(db, 'action_overridden',     'Suite > excl test', 'hash030', null, null, 'pipe-excl-1');

    const { cases, summary } = exportEvalCases(db);
    const excluded = cases.filter(x => x.error_hash === 'hash030');
    assert.equal(excluded.length, 0, 'excluded feedback types should produce no cases');
    assert.ok((summary.skippedCases) >= 3);
  });

  it('summary.feedbackRowsSeen counts all rows including skipped', () => {
    const runId = insertRun(db, 'pipe-cnt-1');
    insertFailure(db, runId, 'Suite > counted', 'hash040', 'FLAKY');
    // 1 valid, 2 excluded
    insertFeedback(db, 'retry_passed',    'Suite > counted', 'hash040', null, null, 'pipe-cnt-1');
    insertFeedback(db, 'retry_failed',    'Suite > counted', 'hash040', null, null, 'pipe-cnt-1');
    insertFeedback(db, 'action_overridden', null, null, null, null, null);

    const { summary } = exportEvalCases(db);
    assert.ok(summary.feedbackRowsSeen >= 3,   'should have counted all feedback rows');
    assert.ok(summary.exportedCases    >= 1,   'at least the retry_passed should export');
    assert.ok(summary.skippedCases     >= 2,   'at least the excluded types should be skipped');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: scorer
// ─────────────────────────────────────────────────────────────────────────────

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    schema_version:          SCHEMA_VERSION,
    case_id:                 'test-case-1',
    repo_id:                 null,
    repo_name:               null,
    pipeline_id:             'pipe-1',
    test_name:               'Suite > test',
    error_hash:              'abc123',
    predicted_category:      'REGRESSION',
    predicted_confidence:    0.9,
    predicted_should_block:  true,
    gold_category:           'REGRESSION',
    gold_should_block:       true,
    evidence_source:         'classification_corrected',
    label_quality:           'high',
    created_at:              '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('eval scorer', () => {
  it('computes block_precision = 1.0 when all predicted-block cases truly block', () => {
    const cases: EvalCase[] = [
      makeCase({ predicted_should_block: true,  gold_should_block: true }),
      makeCase({ predicted_should_block: true,  gold_should_block: true, case_id: 'c2' }),
    ];
    const m = scoreEvalCases(cases);
    assert.equal(m.block_precision, 1.0);
    assert.equal(m.false_block_rate, null, 'no gold_clear cases → false_block_rate = null');
  });

  it('computes false_block_rate correctly', () => {
    const cases: EvalCase[] = [
      makeCase({ case_id: 'c1', predicted_should_block: true,  gold_should_block: false }),  // FP
      makeCase({ case_id: 'c2', predicted_should_block: false, gold_should_block: false }),  // TN
      makeCase({ case_id: 'c3', predicted_should_block: false, gold_should_block: false }),  // TN
    ];
    const m = scoreEvalCases(cases);
    // false_block_rate = FP / gold_clear = 1 / 3
    assert.ok(m.false_block_rate !== null);
    assert.ok(Math.abs(m.false_block_rate - 1 / 3) < 0.001);
  });

  it('computes false_clear_rate correctly', () => {
    const cases: EvalCase[] = [
      makeCase({ case_id: 'c1', predicted_should_block: false, gold_should_block: true }),  // FN
      makeCase({ case_id: 'c2', predicted_should_block: true,  gold_should_block: true }),  // TP
    ];
    const m = scoreEvalCases(cases);
    // false_clear_rate = FN / gold_block = 1 / 2
    assert.ok(m.false_clear_rate !== null);
    assert.equal(m.false_clear_rate, 0.5);
  });

  it('computes category_accuracy on cases with gold_category', () => {
    const cases: EvalCase[] = [
      makeCase({ case_id: 'c1', predicted_category: 'REGRESSION', gold_category: 'REGRESSION' }),  // correct
      makeCase({ case_id: 'c2', predicted_category: 'FLAKY',      gold_category: 'REGRESSION' }),  // wrong
      makeCase({ case_id: 'c3', predicted_category: 'NEW_BUG',    gold_category: null          }),  // no gold
    ];
    const m = scoreEvalCases(cases);
    // category_accuracy = 1/2 (c3 excluded — no gold_category)
    assert.ok(m.category_accuracy !== null);
    assert.equal(m.category_accuracy, 0.5);
    assert.equal(m.counts.with_gold_category, 2);
    assert.equal(m.counts.category_correct,   1);
  });

  it('returns null metrics when dataset is empty', () => {
    const m = scoreEvalCases([]);
    assert.equal(m.caseCount,          0);
    assert.equal(m.block_precision,    null);
    assert.equal(m.false_block_rate,   null);
    assert.equal(m.false_clear_rate,   null);
    assert.equal(m.category_accuracy,  null);
  });

  it('filters out medium-quality cases when min-quality=high', () => {
    const cases: EvalCase[] = [
      makeCase({ case_id: 'high', label_quality: 'high',   predicted_should_block: true,  gold_should_block: true }),
      makeCase({ case_id: 'med',  label_quality: 'medium', predicted_should_block: false, gold_should_block: true }),
    ];
    const m = scoreEvalCases(cases, 'high');
    assert.equal(m.caseCount,                       1, 'medium case should be filtered out');
    assert.equal(m.coverage.totalCasesInDataset,    2);
    assert.equal(m.coverage.casesAfterQualityFilter, 1);
  });

  it('includes medium-quality cases when min-quality=medium', () => {
    const cases: EvalCase[] = [
      makeCase({ case_id: 'high', label_quality: 'high',   gold_category: 'REGRESSION', predicted_category: 'REGRESSION' }),
      makeCase({ case_id: 'med',  label_quality: 'medium', gold_category: null }),
    ];
    const m = scoreEvalCases(cases, 'medium');
    assert.equal(m.caseCount, 2);
  });

  it('coverage counts cases by evidence source', () => {
    const cases: EvalCase[] = [
      makeCase({ case_id: 'a', evidence_source: 'retry_passed',             label_quality: 'high' }),
      makeCase({ case_id: 'b', evidence_source: 'retry_passed',             label_quality: 'high' }),
      makeCase({ case_id: 'c', evidence_source: 'classification_corrected', label_quality: 'high' }),
    ];
    const m = scoreEvalCases(cases);
    assert.equal(m.coverage.casesByEvidenceSource['retry_passed'],             2);
    assert.equal(m.coverage.casesByEvidenceSource['classification_corrected'], 1);
  });

  it('formatMetrics produces non-empty human-readable output', () => {
    const m = scoreEvalCases([
      makeCase({ predicted_should_block: true, gold_should_block: true, gold_category: 'REGRESSION', predicted_category: 'REGRESSION' }),
    ]);
    const output = formatMetrics(m);
    assert.ok(output.includes('block_precision'));
    assert.ok(output.includes('false_block_rate'));
    assert.ok(output.includes('category_accuracy'));
    assert.ok(output.includes('Coverage'));
  });

  it('formatMetrics includes "No eval cases" warning when dataset is empty', () => {
    const output = formatMetrics(scoreEvalCases([]));
    assert.ok(output.includes('No eval cases found'), `expected warning, got: ${output}`);
  });
});
