/**
 * Seed script — populates a local SQLite DB with realistic dummy data
 * so the dashboard can be tested without a real CI pipeline.
 *
 * Usage:
 *   ORACLE_STATE_DB_PATH=./dev.db npx tsx scripts/seed-dev-db.ts
 *
 * Or via npm script:
 *   npm run db:seed
 *
 * Safe to re-run: drops and recreates all rows each time via DELETE + INSERT.
 */

import { initDb, getDb } from '../src/state-store.js';

// ── Config ────────────────────────────────────────────────────────────────────

const DAYS        = 14;   // how many days of history to generate
const RUNS_PER_DAY = 2;   // average pipeline runs per day

const CATEGORIES = ['FLAKY', 'REGRESSION', 'ENV_ISSUE', 'NEW_BUG'] as const;

const TEST_NAMES = [
  'checkout::payment flow should complete',
  'checkout::cart persists on refresh',
  'auth::login with valid credentials',
  'auth::session expires after timeout',
  'search::returns relevant results',
  'search::handles empty query gracefully',
  'notifications::email sent on signup',
  'notifications::slack alert on deploy',
  'api::rate limiter blocks excess requests',
  'api::health endpoint returns 200',
  'dashboard::renders overview tab',
  'dashboard::loads failure data',
];

const PIPELINE_PREFIXES = ['main', 'release/1.4', 'feature/flaky-fix'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function isoDate(daysAgo: number, hour = 10, minuteOffset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minuteOffset, 0, 0);
  return d.toISOString();
}

function hash(s: string): string {
  let h = 0;
  for (const c of s) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return Math.abs(h).toString(16).padStart(8, '0');
}

function fingerprint(runId: number, type: string, scope: string): string {
  return `${type}:${scope}:run${runId}:${hash(type + scope + runId)}`;
}

// ── Seed ──────────────────────────────────────────────────────────────────────

initDb();
const db = getDb();

// Wipe existing data so re-runs are idempotent
db.exec(`
  DELETE FROM actions;
  DELETE FROM failures;
  DELETE FROM runs;
`);
console.log('Cleared existing rows.');

let totalRuns = 0, totalFailures = 0, totalActions = 0;

for (let day = DAYS; day >= 0; day--) {
  const runsToday = RUNS_PER_DAY + (Math.random() > 0.5 ? 1 : 0);

  for (let r = 0; r < runsToday; r++) {
    const hour         = 8 + r * 4 + Math.floor(Math.random() * 2);
    const timestamp    = isoDate(day, hour, Math.floor(Math.random() * 59));
    const pipelineId   = `${pick(PIPELINE_PREFIXES)}-${1000 + totalRuns}`;

    // Bias toward CLEAR on recent days, more BLOCKED earlier
    const clearBias    = day < 4 ? 0.7 : 0.45;
    const isClear      = Math.random() < clearBias;
    const verdict      = isClear ? 'CLEAR' : 'BLOCKED';
    const numFailures  = isClear ? 0 : 1 + Math.floor(Math.random() * 4);

    const categoryCounts: Record<string, number> = {};
    const insertedFailureIds: number[] = [];

    // Insert run
    const runInfo = db.prepare(
      `INSERT INTO runs (timestamp, pipeline_id, total_failures, categories_json, verdict)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(timestamp, pipelineId, numFailures, JSON.stringify(categoryCounts), verdict);

    const runId = runInfo.lastInsertRowid as number;
    totalRuns++;

    if (isClear) continue;

    // Insert failures
    for (let f = 0; f < numFailures; f++) {
      const testName   = pick(TEST_NAMES);
      const category   = pick(CATEGORIES);
      const confidence = 0.6 + Math.random() * 0.38;
      const errHash    = hash(testName + category);

      categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;

      const fi = db.prepare(
        `INSERT INTO failures (run_id, test_name, error_hash, category, confidence)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(runId, testName, errHash, category, confidence);

      insertedFailureIds.push(fi.lastInsertRowid as number);
      totalFailures++;
    }

    // Update categories_json now that we know them
    db.prepare(`UPDATE runs SET categories_json = ? WHERE id = ?`)
      .run(JSON.stringify(categoryCounts), runId);

    // Insert actions for this run
    for (let f = 0; f < insertedFailureIds.length; f++) {
      const failureId  = insertedFailureIds[f]!;
      const testName   = TEST_NAMES[f % TEST_NAMES.length]!;
      const errHash    = hash(testName + CATEGORIES[f % CATEGORIES.length]);
      const createdAt  = timestamp;

      // ~60% chance of a create_jira action
      if (Math.random() < 0.6) {
        const fp = fingerprint(runId, 'create_jira', `${testName}:${errHash}`);
        const executed = Math.random() < 0.8; // 80% succeed
        db.prepare(
          `INSERT OR IGNORE INTO actions
             (run_id, failure_id, scope, action_type, action_fingerprint, source,
              verdict, decision_reason, confidence, created_at, executed_at, execution_ok)
           VALUES (?, ?, 'failure', 'create_jira', ?, 'policy',
                   'approved', 'policy:new_failure', ?, ?, ?, ?)`,
        ).run(
          runId, failureId, fp, 0.85,
          createdAt,
          executed ? createdAt : null,
          executed ? 1 : null,
        );
        totalActions++;
      }

      // ~30% chance of a history-based suppression (rejected duplicate)
      if (Math.random() < 0.30) {
        const reasons = [
          'history:jira_already_created',
          'history:duplicate_pattern',
          'history:retry_consistently_fails',
        ];
        const fp = fingerprint(runId, 'create_jira_suppressed', `${testName}:${errHash}:${f}`);
        db.prepare(
          `INSERT OR IGNORE INTO actions
             (run_id, failure_id, scope, action_type, action_fingerprint, source,
              verdict, decision_reason, confidence, created_at)
           VALUES (?, ?, 'failure', 'create_jira', ?, 'policy',
                   'rejected', ?, ?, ?)`,
        ).run(runId, failureId, fp, pick(reasons), 0.9, createdAt);
        totalActions++;
      }

      // ~20% chance of a notify_slack action (approved)
      if (Math.random() < 0.20) {
        const fp = fingerprint(runId, 'notify_slack', `${testName}:${errHash}`);
        db.prepare(
          `INSERT OR IGNORE INTO actions
             (run_id, failure_id, scope, action_type, action_fingerprint, source,
              verdict, decision_reason, confidence, created_at, executed_at, execution_ok)
           VALUES (?, ?, 'failure', 'notify_slack', ?, 'policy',
                   'approved', 'policy:high_confidence', ?, ?, ?, 1)`,
        ).run(runId, failureId, fp, 0.75, createdAt, createdAt);
        totalActions++;
      }

      // ~10% chance of a held quarantine action
      if (Math.random() < 0.10) {
        const fp = fingerprint(runId, 'quarantine_test', `${testName}:${errHash}`);
        db.prepare(
          `INSERT OR IGNORE INTO actions
             (run_id, failure_id, scope, action_type, action_fingerprint, source,
              verdict, decision_reason, confidence, created_at)
           VALUES (?, ?, 'failure', 'quarantine_test', ?, 'policy',
                   'held', 'policy:low_confidence', ?, ?)`,
        ).run(runId, failureId, fp, 0.45, createdAt);
        totalActions++;
      }
    }
  }
}

console.log(`
✅  Seed complete
    Runs:     ${totalRuns}
    Failures: ${totalFailures}
    Actions:  ${totalActions}
    DB path:  ${process.env['ORACLE_STATE_DB_PATH'] ?? './oracle-state.db'}
`);
