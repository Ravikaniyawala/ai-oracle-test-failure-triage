import Database from 'better-sqlite3';
import {
  type ActionExecution,
  type ActionProposal,
  type AgentProposal,
  type AgentProposalStatus,
  type Decision,
  type FeedbackEntry,
  type PatternStats,
  type PrContext,
  type RecentFailurePattern,
  type TriageResult,
} from './types.js';

const DB_PATH = process.env['ORACLE_STATE_DB_PATH'] ?? './oracle-state.db';
let db: Database.Database;

export function initDb(): void {
  db = new Database(DB_PATH);
  // WAL mode allows concurrent readers alongside a writer without SQLITE_BUSY errors.
  // busy_timeout gives write-contention retries up to 5 s before hard-failing.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       TEXT    NOT NULL,
      pipeline_id     TEXT    NOT NULL,
      total_failures  INTEGER NOT NULL,
      categories_json TEXT    NOT NULL,
      verdict         TEXT    NOT NULL DEFAULT 'BLOCKED'
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
      created_at         TEXT,
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
    CREATE TABLE IF NOT EXISTS pr_context (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_id        TEXT    NOT NULL,
      pr_number          INTEGER,
      title              TEXT,
      author             TEXT,
      base_branch        TEXT,
      head_branch        TEXT,
      files_changed_json TEXT    NOT NULL,
      linked_jira_json   TEXT    NOT NULL,
      created_at         TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_proposals (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      source_agent              TEXT    NOT NULL,
      pipeline_id               TEXT    NOT NULL,
      test_name                 TEXT    NOT NULL,
      error_hash                TEXT    NOT NULL,
      proposal_type             TEXT    NOT NULL,
      payload_json              TEXT,
      confidence                REAL    NOT NULL,
      reasoning                 TEXT,
      status                    TEXT    NOT NULL DEFAULT 'received',
      decision_reason           TEXT,
      linked_action_fingerprint TEXT,
      created_at                TEXT    NOT NULL
    );
  `);

  // Additive migrations for DBs created before these columns were added.
  const addCol = (table: string, col: string, def: string): void => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
  };
  addCol('actions', 'payload_json',    'TEXT');
  addCol('actions', 'risk_score',      'REAL');
  addCol('actions', 'decision_reason', 'TEXT');
  addCol('actions', 'confidence',      'REAL');
  addCol('actions', 'created_at',      'TEXT');
  addCol('runs',    'verdict',         "TEXT NOT NULL DEFAULT 'BLOCKED'");
  addCol('runs',    'repo_id',           'TEXT');
  addCol('runs',    'repo_name',         'TEXT');
  addCol('runs',    'repo_display_name', 'TEXT');
}

/**
 * Return the raw better-sqlite3 Database handle for read-only dashboard queries.
 * Must only be called after initDb().
 */
export function getDb(): Database.Database {
  return db;
}

export function saveRun(
  pipelineId:    string,
  totalFailures: number,
  results:       TriageResult[],
  verdict:       'CLEAR' | 'BLOCKED',
  repoIdentity?: { repoId: string; repoName: string; repoDisplayName: string } | null,
): number {
  const categories = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.category] = (acc[r.category] ?? 0) + 1;
    return acc;
  }, {});

  const stmt = db.prepare(
    `INSERT INTO runs (timestamp, pipeline_id, total_failures, categories_json, verdict, repo_id, repo_name, repo_display_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    new Date().toISOString(),
    pipelineId,
    totalFailures,
    JSON.stringify(categories),
    verdict,
    repoIdentity?.repoId           ?? null,
    repoIdentity?.repoName         ?? null,
    repoIdentity?.repoDisplayName  ?? null,
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
 * executing the action.
 */
export function saveAction(
  runId: number,
  proposal: ActionProposal,
  decision: Decision,
): boolean {
  const info = db.prepare(
    `INSERT OR IGNORE INTO actions
       (run_id, failure_id, cluster_key, scope, action_type, action_fingerprint,
        source, verdict, payload_json, risk_score, decision_reason, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    null,
    decision.reason,
    decision.confidence,
    new Date().toISOString(),
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

/**
 * Persist a received agent proposal and return its DB row id.
 * Initial status is always 'received'.
 */
export function saveAgentProposal(proposal: AgentProposal): number {
  const info = db.prepare(
    `INSERT INTO agent_proposals
       (source_agent, pipeline_id, test_name, error_hash, proposal_type,
        payload_json, confidence, reasoning, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`
  ).run(
    proposal.sourceAgent,
    proposal.pipelineId,
    proposal.testName,
    proposal.errorHash,
    proposal.proposalType,
    JSON.stringify(proposal.payload),
    proposal.confidence,
    proposal.reasoning,
    new Date().toISOString(),
  );
  return info.lastInsertRowid as number;
}

/**
 * Update the status, decision reason, and linked fingerprint of an agent proposal.
 * Called after decisioning and again after execution.
 */
export function updateAgentProposalStatus(
  id: number,
  status: AgentProposalStatus,
  decisionReason: string,
  fingerprint: string,
): void {
  db.prepare(
    `UPDATE agent_proposals
     SET status = ?, decision_reason = ?, linked_action_fingerprint = ?
     WHERE id = ?`
  ).run(status, decisionReason, fingerprint, id);
}

/**
 * Compute historical pattern stats for a failure identified by testName + errorHash.
 *
 * actionCount        — total action rows recorded for this testName:errorHash pair
 * jiraCreatedCount   — create_jira actions that executed successfully
 * jiraDuplicateCount — distinct feedback rows marked jira_closed_duplicate,
 *                      matched by test_name+error_hash OR by action_fingerprint
 *                      of any action associated with this pattern
 * retryPassedCount   — feedback rows marked retry_passed for this pattern
 * retryFailedCount   — feedback rows marked retry_failed for this pattern
 *
 * Slice 3.1: used for explainability logging and oracle-verdict.json output.
 * Slice 3.2: jiraDuplicateCount/jiraCreatedCount and retryPassedCount/retryFailedCount
 * are passed into the policy engine to influence a small set of decisions explicitly.
 */
export function getPatternStats(testName: string, errorHash: string): PatternStats {
  const scopeId = `${testName}:${errorHash}`;

  const actionCount = (db.prepare(
    `SELECT COUNT(*) as count FROM actions
     WHERE json_extract(payload_json, '$.scopeId') = ?`,
  ).get(scopeId) as { count: number }).count;

  const jiraCreatedCount = (db.prepare(
    `SELECT COUNT(*) as count FROM actions
     WHERE action_type = 'create_jira'
       AND execution_ok = 1
       AND json_extract(payload_json, '$.scopeId') = ?`,
  ).get(scopeId) as { count: number }).count;

  // COUNT(DISTINCT id) prevents double-counting if a feedback row matches both
  // the test_name+error_hash condition and the action_fingerprint subquery.
  const jiraDuplicateCount = (db.prepare(
    `SELECT COUNT(DISTINCT f.id) as count
     FROM feedback f
     WHERE f.feedback_type = 'jira_closed_duplicate'
       AND (
         (f.test_name = ? AND f.error_hash = ?)
         OR f.action_fingerprint IN (
           SELECT action_fingerprint FROM actions
           WHERE json_extract(payload_json, '$.scopeId') = ?
         )
       )`,
  ).get(testName, errorHash, scopeId) as { count: number }).count;

  const retryPassedCount = (db.prepare(
    `SELECT COUNT(*) as count FROM feedback
     WHERE feedback_type = 'retry_passed'
       AND test_name = ? AND error_hash = ?`,
  ).get(testName, errorHash) as { count: number }).count;

  const retryFailedCount = (db.prepare(
    `SELECT COUNT(*) as count FROM feedback
     WHERE feedback_type = 'retry_failed'
       AND test_name = ? AND error_hash = ?`,
  ).get(testName, errorHash) as { count: number }).count;

  return { actionCount, jiraCreatedCount, jiraDuplicateCount, retryPassedCount, retryFailedCount };
}

/**
 * Persist a PR context snapshot for the current pipeline run.
 * Called once per triage run when ORACLE_PR_CONTEXT_PATH is provided.
 * Read-only at decision time — stored here for audit and future querying.
 */
export function savePrContext(ctx: PrContext): void {
  db.prepare(
    `INSERT INTO pr_context
       (pipeline_id, pr_number, title, author, base_branch, head_branch,
        files_changed_json, linked_jira_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ctx.pipelineId,
    ctx.prNumber      ?? null,
    ctx.title         ?? null,
    ctx.author        ?? null,
    ctx.baseBranch    ?? null,
    ctx.headBranch    ?? null,
    JSON.stringify(ctx.filesChanged),
    JSON.stringify(ctx.linkedJira),
    new Date().toISOString(),
  );
}

/**
 * Returns recent-history statistics for a failure identified by
 * `testName + errorHash` (both fields required — error hashes are not globally
 * unique across different tests).
 *
 * The `lookback` window is applied via a CTE so counts reflect only the N
 * most-recent failures, not all-time history.
 *
 * Returns undefined when no matching rows exist in the window.
 *
 * NOTE: "recent" is scoped to *this* Oracle state DB.  In GitHub Actions the DB
 * is restored from a per-repository cache, so history only extends back as far
 * as the most recently saved cache entry for this repository.
 */
export function getRecentFailurePattern(
  testName:  string,
  errorHash: string,
  lookback = 20,
): RecentFailurePattern | undefined {
  if (!db) return undefined;

  // CTE selects the N most-recent rows for this test+hash pair.
  // dominant CTE picks the top category by count within that window.
  // Outer SELECT assembles all three values in one pass.
  //
  // When the window is empty the dominant CTE has no rows, so the outer
  // SELECT returns no rows and .get() returns undefined.
  const row = db.prepare(
    `WITH recent AS (
       SELECT category FROM failures
       WHERE test_name = ? AND error_hash = ?
       ORDER BY id DESC
       LIMIT ?
     ),
     dominant AS (
       SELECT category, COUNT(*) AS cnt
       FROM recent
       GROUP BY category
       ORDER BY cnt DESC
       LIMIT 1
     )
     SELECT
       d.category                     AS dominantCategory,
       d.cnt                          AS dominantCategoryCount,
       (SELECT COUNT(*) FROM recent)  AS totalCount
     FROM dominant d`,
  ).get(testName, errorHash, lookback) as RecentFailurePattern | undefined;

  return row;
}
