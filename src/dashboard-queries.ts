/**
 * Read-only query helpers for Oracle Dashboard V1.
 *
 * All functions read from the SQLite DB via the handle returned by getDb().
 * They never write to the DB and never touch log files or markdown artifacts.
 *
 * Date filtering is always optional:
 *   - Pass ISO 8601 strings (e.g. '2026-01-01', '2026-04-09T23:59:59Z').
 *   - Omit (undefined) to include all rows.
 *
 * Queries are intentionally simple and index-friendly — no window functions,
 * no CTEs, no JSON aggregation beyond what SQLite handles cleanly.
 */

import { getDb } from './state-store.js';
import {
  type ActionTypeTrendRow,
  type FailureCategoryTrendRow,
  type OverviewStats,
  type RecurringFailureRow,
  type RunVerdictTrendRow,
  type SuppressionSummaryRow,
} from './types.js';

// ── Date clause helpers ───────────────────────────────────────────────────────

/**
 * COALESCE sentinels that cover all realistic ISO timestamps when no bound is given.
 */
const DATE_MIN = '1970-01-01T00:00:00.000Z';
const DATE_MAX = '9999-12-31T23:59:59.999Z';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns daily run counts split by verdict ('CLEAR' | 'BLOCKED').
 *
 * Each row represents one (day, verdict) pair.  Days with no runs are absent —
 * fill gaps in the UI layer.
 *
 * Dashboard use: run health trend chart, CLEAR rate over time.
 */
export function getRunVerdictTrend(
  startDate?: string,
  endDate?:   string,
): RunVerdictTrendRow[] {
  return getDb().prepare<[string, string], RunVerdictTrendRow>(`
    SELECT
      date(timestamp) AS day,
      verdict,
      COUNT(*)        AS count
    FROM runs
    WHERE timestamp >= ?
      AND timestamp <= ?
    GROUP BY day, verdict
    ORDER BY day ASC
  `).all(startDate ?? DATE_MIN, endDate ?? DATE_MAX);
}

/**
 * Returns daily failure counts broken down by triage category.
 *
 * Each row is one (day, category) pair. Joins failures → runs for timestamps.
 *
 * Dashboard use: category distribution over time, FLAKY vs REGRESSION trend.
 */
export function getFailureCategoryTrend(
  startDate?: string,
  endDate?:   string,
): FailureCategoryTrendRow[] {
  return getDb().prepare<[string, string], FailureCategoryTrendRow>(`
    SELECT
      date(r.timestamp) AS day,
      f.category,
      COUNT(*)          AS count
    FROM failures f
    JOIN runs r ON f.run_id = r.id
    WHERE r.timestamp >= ?
      AND r.timestamp <= ?
    GROUP BY day, f.category
    ORDER BY day ASC
  `).all(startDate ?? DATE_MIN, endDate ?? DATE_MAX);
}

/**
 * Returns daily action counts broken down by type and verdict.
 *
 * Uses actions.created_at (added in dashboard-prep migration).  Rows created
 * before the migration (created_at IS NULL) are excluded from date-filtered
 * results; they appear in unfiltered queries via a fallback join on runs.timestamp.
 *
 * Dashboard use: action volume over time, approved vs rejected/held split.
 */
export function getActionTypeTrend(
  startDate?: string,
  endDate?:   string,
): ActionTypeTrendRow[] {
  const db = getDb();

  if (startDate !== undefined || endDate !== undefined) {
    // Date-filtered: use created_at directly (only rows post-migration have it).
    return db.prepare<[string, string], ActionTypeTrendRow>(`
      SELECT
        date(a.created_at) AS day,
        a.action_type,
        a.verdict,
        COUNT(*)           AS count
      FROM actions a
      WHERE a.created_at IS NOT NULL
        AND a.created_at >= ?
        AND a.created_at <= ?
      GROUP BY day, a.action_type, a.verdict
      ORDER BY day ASC
    `).all(startDate ?? DATE_MIN, endDate ?? DATE_MAX);
  }

  // No date filter: include pre-migration rows via run timestamp fallback.
  // COALESCE prefers created_at; falls back to the parent run's timestamp.
  // Agent-mode actions (run_id = 0) with no created_at are excluded from
  // the fallback join since there is no matching runs row.
  return db.prepare<[], ActionTypeTrendRow>(`
    SELECT
      date(COALESCE(a.created_at, r.timestamp)) AS day,
      a.action_type,
      a.verdict,
      COUNT(*)                                  AS count
    FROM actions a
    LEFT JOIN runs r ON a.run_id = r.id AND a.run_id != 0
    WHERE COALESCE(a.created_at, r.timestamp) IS NOT NULL
    GROUP BY day, a.action_type, a.verdict
    ORDER BY day ASC
  `).all();
}

/**
 * Returns the most frequently failing (test_name, error_hash) pairs,
 * ordered by occurrence count descending.
 *
 * Dashboard use: "top recurring failures" table, noise / flakiness hot list.
 *
 * @param limit  Maximum rows to return. Defaults to 10.
 */
export function getTopRecurringFailures(
  startDate?: string,
  endDate?:   string,
  limit = 10,
): RecurringFailureRow[] {
  return getDb().prepare<[string, string, number], RecurringFailureRow>(`
    SELECT
      f.test_name,
      f.error_hash,
      COUNT(*)          AS occurrences,
      MAX(r.timestamp)  AS last_seen
    FROM failures f
    JOIN runs r ON f.run_id = r.id
    WHERE r.timestamp >= ?
      AND r.timestamp <= ?
    GROUP BY f.test_name, f.error_hash
    ORDER BY occurrences DESC
    LIMIT ?
  `).all(startDate ?? DATE_MIN, endDate ?? DATE_MAX, limit);
}

/**
 * Returns a breakdown of history-based action suppressions — actions that were
 * rejected by the policy engine because past data indicated they would be
 * unhelpful (e.g. duplicate Jiras, retry patterns that consistently fail).
 *
 * Only rows with decision_reason LIKE 'history:%' are included.
 * These are durable rows in the actions table — not log entries.
 *
 * Dashboard use: "Oracle saved you N duplicate Jira tickets" value metric.
 */
export function getSuppressionSummary(
  startDate?: string,
  endDate?:   string,
): SuppressionSummaryRow[] {
  const db = getDb();

  if (startDate !== undefined || endDate !== undefined) {
    return db.prepare<[string, string], SuppressionSummaryRow>(`
      SELECT
        decision_reason,
        COUNT(*) AS count
      FROM actions
      WHERE verdict         = 'rejected'
        AND decision_reason LIKE 'history:%'
        AND created_at IS NOT NULL
        AND created_at >= ?
        AND created_at <= ?
      GROUP BY decision_reason
      ORDER BY count DESC
    `).all(startDate ?? DATE_MIN, endDate ?? DATE_MAX);
  }

  // No date filter: include pre-migration rows (created_at may be NULL).
  return db.prepare<[], SuppressionSummaryRow>(`
    SELECT
      decision_reason,
      COUNT(*) AS count
    FROM actions
    WHERE verdict         = 'rejected'
      AND decision_reason LIKE 'history:%'
    GROUP BY decision_reason
    ORDER BY count DESC
  `).all();
}

/**
 * Derives high-level overview stats from the existing query helpers.
 * Called by GET /api/v1/overview.
 */
export function getOverviewStats(): OverviewStats {
  const db = getDb();

  const { total, clear } = db.prepare<[], { total: number; clear: number }>(`
    SELECT
      COUNT(*)                                           AS total,
      SUM(CASE WHEN verdict = 'CLEAR' THEN 1 ELSE 0 END) AS clear
    FROM runs
  `).get() ?? { total: 0, clear: 0 };

  const totalFailures = (db.prepare<[], { count: number }>(
    `SELECT COUNT(*) AS count FROM failures`,
  ).get() ?? { count: 0 }).count;

  const suppressionsSaved = (db.prepare<[], { count: number }>(
    `SELECT COUNT(*) AS count FROM actions
     WHERE verdict = 'rejected' AND decision_reason LIKE 'history:%'`,
  ).get() ?? { count: 0 }).count;

  const jirasCreated = (db.prepare<[], { count: number }>(
    `SELECT COUNT(*) AS count FROM actions
     WHERE action_type = 'create_jira' AND execution_ok = 1`,
  ).get() ?? { count: 0 }).count;

  // Category breakdown from the failures table
  const catRows = db.prepare<[], { category: string; count: number }>(
    `SELECT category, COUNT(*) AS count FROM failures GROUP BY category`,
  ).all();
  const categoryBreakdown: Record<string, number> = {};
  for (const row of catRows) categoryBreakdown[row.category] = row.count;

  return {
    totalRuns:        total,
    clearRate:        total > 0 ? clear / total : 0,
    failuresTriaged:  totalFailures,
    jirasCreated,
    suppressionsSaved,
    categoryBreakdown,
  };
}
