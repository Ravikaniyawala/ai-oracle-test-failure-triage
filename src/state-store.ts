import Database from 'better-sqlite3';
import { type TriageResult } from './types.js';

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
  `);
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

export function saveFailures(runId: number, results: TriageResult[]): void {
  const stmt = db.prepare(
    `INSERT INTO failures (run_id, test_name, error_hash, category, confidence)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const r of results) {
    stmt.run(runId, r.testName, r.errorHash, r.category, r.confidence);
  }
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
