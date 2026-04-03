import Database from 'better-sqlite3';
import {
  type ActionExecution,
  type ActionProposal,
  type Decision,
  type FeedbackEntry,
  type TriageResult,
} from './types.js';

const DB_PATH = process.env['ORACLE_STATE_DB_PATH'] ?? './oracle-state.db';
let db: Database.Database;

export function initDb(): void {
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       TEXT    NOT NULL,
      pipeline_id     TEXT    NOT NULL,
      total_failures  INTEGER NOT NULL,
      categories_json TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS failures (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id      INTEGER NOT NULL,
      test_name   TEXT    NOT NULL,
      error_hash  TEXT    NOT NULL,
      category    TEXT    NOT NULL,
      confidence  REAL    NOT NULL,
      fix_applied INTEGER DEFAULT 0,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    CREATE TABLE IF NOT EXISTS instinct_feedback (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      instinct_id TEXT    NOT NULL,
      was_correct INTEGER NOT NULL,
      timestamp   TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS actions (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id             INTEGER NOT NULL,
      failure_id         INTEGER,
      cluster_key        TEXT,
      scope              TEXT    NOT NULL,
      action_type        TEXT    NOT NULL,
      action_fingerprint TEXT    NOT NULL UNIQUE,
      source             TEXT    NOT NULL DEFAULT 'policy',
      verdict            TEXT    NOT NULL,
      payload_json       TEXT,
      risk_score         REAL,
      decision_reason    TEXT,
      confidence         REAL,
      executed_at        TEXT,
      execution_ok       INTEGER,
      execution_detail   TEXT,
      FOREIGN KEY (run_id)     REFERENCES runs(id),
      FOREIGN KEY (failure_id) REFERENCES failures(id)
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      feedback_type      TEXT    NOT NULL,
      pipeline_id        TEXT,
      test_name          TEXT,
      error_hash         TEXT,
      action_fingerprint TEXT,
      old_value          TEXT,
      new_value          TEXT,
      notes              TEXT,
      created_at         TEXT    NOT NULL
    );
  `);

  // Additive migrations for DBs created before audit / feedback columns were added.
  const addCol = (table: string, col: string, def: string): void => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
  };
  addCol('actions', 'payload_json',    'TEXT');
  addCol('actions', 'risk_score',      'REAL');
  addCol('actions', 'decision_reason', 'TEXT');
  addCol('actions', 'confidence',      'REAL');
}

export function saveRun(
  pipelineId: string,
  totalFailures: number,
  results: TriageResult[],
): number {
  const categories = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.category] = (acc[r.category] ?? 0) + 1;
    return acc;
  }, {});

  const stmt = db.prepare(
    `INSERT INTO runs (timestamp, pipeline_id, total_failures, categories_json)
     VALUES (?, ?, ?, ?)`
  );
  const info = stmt.run(
    new Date().toISOString(),
    pipelineId,
    totalFailures,
    JSON.stringify(categories),
  );
  return info.lastInsertRowid as number;
}

/**
 * Persists all failures for a run and returns their DB IDs in the same order
 * as the input `results` array.  Callers use `failureIds[i]` to reference the
 * DB row for `results[i]`.
 */
export function saveFailures(runId: number, results: TriageResult[]): number[] {
  const stmt = db.prepare(
    `INSERT INTO failures (run_id, test_name, error_hash, category, confidence)
     VALUES (?, ?, ?, ?, ?)`
  );
  const ids: number[] = [];
  for (const r of results) {
    const info = stmt.run(runId, r.testName, r.errorHash, r.category, r.confidence);
    ids.push(info.lastInsertRowid as number);
  }
  return ids;
}

/**
 * Persist a proposed action and its decision verdict.
 * INSERT OR IGNORE ensures duplicate fingerprints are silently skipped.
 *
 * Returns true if the row was newly inserted, false if it already existed
 * (duplicate fingerprint).  Callers MUST check this return value before
 * executing the action — a false return means the action was already handled
 * in a previous run and must not be re-executed.
 */
export function saveAction(
  runId: number,
  proposal: ActionProposal,
  decision: Decision,
): boolean {
  const info = db.prepare(
    `INSERT OR IGNORE INTO actions
       (run_id, failure_id, cluster_key, scope, action_type, action_fingerprint,
        source, verdict, payload_json, risk_score, decision_reason, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    proposal.failureId ?? null,
    proposal.clusterKey ?? null,
    proposal.scope,
    proposal.type,
    proposal.fingerprint,
    proposal.source,
    decision.verdict,
    JSON.stringify(proposal),
    null,                 // risk_score: not computed in Step 1
    decision.reason,
    decision.confidence,
  );
  return info.changes === 1;
}

/**
 * Record the outcome of executing an action identified by its fingerprint.
 */
export function recordActionExecution(
  fingerprint: string,
  exec: ActionExecution,
): void {
  db.prepare(
    `UPDATE actions
     SET executed_at = ?, execution_ok = ?, execution_detail = ?
     WHERE action_fingerprint = ?`
  ).run(exec.timestamp, exec.ok ? 1 : 0, exec.detail, fingerprint);
}

/**
 * Returns true if an action with this fingerprint already exists in the DB.
 */
export function isActionDuplicate(fingerprint: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM actions WHERE action_fingerprint = ? LIMIT 1`
  ).get(fingerprint);
  return row !== undefined;
}

/**
 * Returns true if a create_jira action with this fingerprint previously
 * succeeded (execution_ok = 1).  Used by the policy engine to suppress
 * duplicate Jira tickets across pipeline re-runs.
 */
export function wasJiraCreatedFor(fingerprint: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM actions
     WHERE action_fingerprint = ?
       AND action_type = 'create_jira'
       AND execution_ok = 1
     LIMIT 1`
  ).get(fingerprint);
  return row !== undefined;
}

/**
 * Persist a single feedback entry.
 */
export function saveFeedback(entry: FeedbackEntry): void {
  db.prepare(
    `INSERT INTO feedback
       (feedback_type, pipeline_id, test_name, error_hash, action_fingerprint,
        old_value, new_value, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.feedbackType,
    entry.pipelineId        ?? null,
    entry.testName          ?? null,
    entry.errorHash         ?? null,
    entry.actionFingerprint ?? null,
    entry.oldValue          ?? null,
    entry.newValue          ?? null,
    entry.notes             ?? null,
    entry.createdAt,
  );
}

export function getRecentFailurePattern(
  errorHash: string,
  lookback = 20,
): { category: string; count: number } | undefined {
  if (!db) return undefined;
  return db.prepare(
    `SELECT category, COUNT(*) as count
     FROM failures
     WHERE error_hash = ?
     ORDER BY id DESC
     LIMIT ?`
  ).get(errorHash, lookback) as { category: string; count: number } | undefined;
}
