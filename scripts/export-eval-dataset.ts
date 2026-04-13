/**
 * Export a labeled eval dataset from Oracle's SQLite state DB.
 *
 * Usage:
 *   ORACLE_STATE_DB_PATH=/path/to/oracle-state.db \
 *     npx tsx scripts/export-eval-dataset.ts [--output path] [--min-quality medium]
 *
 * Each exported case is a JSONL line conforming to schema_version=1.
 * See evals/README.md for the full dataset contract.
 */

import Database from 'better-sqlite3';
import { writeFileSync } from 'fs';
import { createWriteStream } from 'fs';

// ── Types ─────────────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;

export const BLOCKING_CATEGORIES = new Set(['REGRESSION', 'NEW_BUG']);
export const VALID_CATEGORIES    = new Set(['FLAKY', 'REGRESSION', 'ENV_ISSUE', 'NEW_BUG']);

export type LabelQuality = 'high' | 'medium';

export interface EvalCase {
  schema_version:        number;
  case_id:               string;
  repo_id:               string | null;
  repo_name:             string | null;
  pipeline_id:           string;
  test_name:             string;
  error_hash:            string;
  predicted_category:    string;
  predicted_confidence:  number;
  predicted_should_block: boolean;
  gold_category:         string | null;
  gold_should_block:     boolean;
  evidence_source:       string;
  label_quality:         LabelQuality;
  created_at:            string;
}

export interface ExportSummary {
  feedbackRowsSeen:   number;
  exportedCases:      number;
  skippedCases:       number;
  skipReasons:        Record<string, number>;
  casesByEvidenceSource: Record<string, number>;
}

// ── DB row types ──────────────────────────────────────────────────────────────

interface FeedbackRow {
  id:                number;
  feedback_type:     string;
  pipeline_id:       string | null;
  test_name:         string | null;
  error_hash:        string | null;
  action_fingerprint: string | null;
  old_value:         string | null;
  new_value:         string | null;
  notes:             string | null;
  created_at:        string;
}

interface FailureRow {
  id:         number;
  run_id:     number;
  test_name:  string;
  error_hash: string;
  category:   string;
  confidence: number;
}

interface RunRow {
  id:          number;
  pipeline_id: string;
  repo_id:     string | null;
  repo_name:   string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveBlockFromCategory(category: string | null): boolean {
  return category !== null && BLOCKING_CATEGORIES.has(category);
}

/**
 * Find the failure row that a feedback row is labeling.
 *
 * Strategy:
 * - If `pipelineId` is provided, anchor the lookup to that specific run.
 *   If no failure in that run matches test_name + error_hash, return null.
 * - If no `pipelineId`, fetch all matching failures across all runs.
 *   If two or more runs produced different categories for this pattern the
 *   feedback is ambiguous (we cannot know which prediction it refers to) —
 *   return null.  If they all agree, use the most recent row.
 */
function findFailure(
  db:         Database.Database,
  testName:   string,
  errorHash:  string,
  pipelineId: string | null,
): { failure: FailureRow; run: RunRow } | null {
  if (pipelineId) {
    // Anchored: look only in the specific pipeline the feedback references.
    const row = db.prepare<[string, string, string], FailureRow & RunRow>(`
      SELECT f.id, f.run_id, f.test_name, f.error_hash, f.category, f.confidence,
             r.pipeline_id, r.repo_id, r.repo_name
      FROM   failures f
      JOIN   runs r ON r.id = f.run_id
      WHERE  f.test_name = ? AND f.error_hash = ? AND r.pipeline_id = ?
      ORDER  BY f.id DESC
      LIMIT  1
    `).get(testName, errorHash, pipelineId);

    if (!row) return null;
    return {
      failure: { id: row.id, run_id: row.run_id, test_name: row.test_name,
                 error_hash: row.error_hash, category: row.category, confidence: row.confidence },
      run:     { id: row.run_id, pipeline_id: row.pipeline_id,
                 repo_id: row.repo_id ?? null, repo_name: row.repo_name ?? null },
    };
  }

  // Unanchored: fetch all matching failures and check for category ambiguity.
  const rows = db.prepare<[string, string], FailureRow & RunRow>(`
    SELECT f.id, f.run_id, f.test_name, f.error_hash, f.category, f.confidence,
           r.pipeline_id, r.repo_id, r.repo_name
    FROM   failures f
    JOIN   runs r ON r.id = f.run_id
    WHERE  f.test_name = ? AND f.error_hash = ?
    ORDER  BY f.id DESC
  `).all(testName, errorHash);

  if (rows.length === 0) return null;

  // Skip if different runs produced different classifications — we cannot
  // safely attribute the feedback to one specific prediction.
  const firstCategory = rows[0].category;
  for (const r of rows) {
    if (r.category !== firstCategory) return null;
  }

  const row = rows[0];
  return {
    failure: { id: row.id, run_id: row.run_id, test_name: row.test_name,
               error_hash: row.error_hash, category: row.category, confidence: row.confidence },
    run:     { id: row.run_id, pipeline_id: row.pipeline_id,
               repo_id: row.repo_id ?? null, repo_name: row.repo_name ?? null },
  };
}

/**
 * Core export logic: reads feedback table and maps each row to an EvalCase.
 * Returns cases + a summary of what was exported and skipped.
 *
 * Exported as a named function so tests can call it directly without spawning
 * a subprocess.
 */
export function exportEvalCases(
  db:         Database.Database,
  minQuality: LabelQuality = 'high',
): { cases: EvalCase[]; summary: ExportSummary } {
  const feedbackRows = db.prepare<[], FeedbackRow>(`
    SELECT id, feedback_type, pipeline_id, test_name, error_hash,
           action_fingerprint, old_value, new_value, notes, created_at
    FROM   feedback
    ORDER  BY id ASC
  `).all();

  const cases:       EvalCase[]              = [];
  const skipReasons: Record<string, number>  = {};
  const bySource:    Record<string, number>  = {};

  function skip(reason: string): void {
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
  }

  for (const row of feedbackRows) {
    const ft = row.feedback_type;

    // ── classification_corrected ──────────────────────────────────────────
    if (ft === 'classification_corrected') {
      if (!row.test_name || !row.error_hash) {
        skip('classification_corrected:missing_test_or_hash'); continue;
      }
      const newCat = row.new_value?.trim() ?? '';
      if (!VALID_CATEGORIES.has(newCat)) {
        skip('classification_corrected:invalid_new_category'); continue;
      }
      const found = findFailure(db, row.test_name, row.error_hash, row.pipeline_id ?? null);
      if (!found) {
        skip('classification_corrected:no_matching_failure'); continue;
      }
      cases.push({
        schema_version:         SCHEMA_VERSION,
        case_id:                `fb${row.id}:${row.error_hash.slice(0, 8)}:${ft}`,
        repo_id:                found.run.repo_id,
        repo_name:              found.run.repo_name,
        pipeline_id:            found.run.pipeline_id,
        test_name:              found.failure.test_name,
        error_hash:             found.failure.error_hash,
        predicted_category:     found.failure.category,
        predicted_confidence:   found.failure.confidence,
        predicted_should_block: deriveBlockFromCategory(found.failure.category),
        gold_category:          newCat,
        gold_should_block:      deriveBlockFromCategory(newCat),
        evidence_source:        ft,
        label_quality:          'high',
        created_at:             row.created_at,
      });
      bySource[ft] = (bySource[ft] ?? 0) + 1;
      continue;
    }

    // ── retry_passed → FLAKY ────────────────────────────────────────────
    if (ft === 'retry_passed') {
      if (!row.test_name || !row.error_hash) {
        skip('retry_passed:missing_test_or_hash'); continue;
      }
      const found = findFailure(db, row.test_name, row.error_hash, row.pipeline_id ?? null);
      if (!found) {
        skip('retry_passed:no_matching_failure'); continue;
      }
      cases.push({
        schema_version:         SCHEMA_VERSION,
        case_id:                `fb${row.id}:${row.error_hash.slice(0, 8)}:${ft}`,
        repo_id:                found.run.repo_id,
        repo_name:              found.run.repo_name,
        pipeline_id:            found.run.pipeline_id,
        test_name:              found.failure.test_name,
        error_hash:             found.failure.error_hash,
        predicted_category:     found.failure.category,
        predicted_confidence:   found.failure.confidence,
        predicted_should_block: deriveBlockFromCategory(found.failure.category),
        gold_category:          'FLAKY',
        gold_should_block:      false,
        evidence_source:        ft,
        label_quality:          'high',
        created_at:             row.created_at,
      });
      bySource[ft] = (bySource[ft] ?? 0) + 1;
      continue;
    }

    // ── jira_closed_confirmed → block=true, category unknown ─────────────
    if (ft === 'jira_closed_confirmed') {
      if (minQuality === 'high') {
        // jira_closed_confirmed is medium-quality (no category info) — skip
        // unless caller explicitly wants medium+ labels
        skip('jira_closed_confirmed:quality_below_minimum'); continue;
      }
      if (!row.test_name || !row.error_hash) {
        skip('jira_closed_confirmed:missing_test_or_hash'); continue;
      }
      const found = findFailure(db, row.test_name, row.error_hash, row.pipeline_id ?? null);
      if (!found) {
        skip('jira_closed_confirmed:no_matching_failure'); continue;
      }
      cases.push({
        schema_version:         SCHEMA_VERSION,
        case_id:                `fb${row.id}:${row.error_hash.slice(0, 8)}:${ft}`,
        repo_id:                found.run.repo_id,
        repo_name:              found.run.repo_name,
        pipeline_id:            found.run.pipeline_id,
        test_name:              found.failure.test_name,
        error_hash:             found.failure.error_hash,
        predicted_category:     found.failure.category,
        predicted_confidence:   found.failure.confidence,
        predicted_should_block: deriveBlockFromCategory(found.failure.category),
        gold_category:          null,
        gold_should_block:      true,
        evidence_source:        ft,
        label_quality:          'medium',
        created_at:             row.created_at,
      });
      bySource[ft] = (bySource[ft] ?? 0) + 1;
      continue;
    }

    // ── All other feedback types: skip ────────────────────────────────────
    skip(`${ft}:excluded_in_v1`);
  }

  return {
    cases,
    summary: {
      feedbackRowsSeen:      feedbackRows.length,
      exportedCases:         cases.length,
      skippedCases:          feedbackRows.length - cases.length,
      skipReasons,
      casesByEvidenceSource: bySource,
    },
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

import { fileURLToPath } from 'url';

function main(): void {
  const args        = process.argv.slice(2);
  const outputIdx   = args.indexOf('--output');
  const qualityIdx  = args.indexOf('--min-quality');

  const outputPath  = outputIdx  >= 0 ? args[outputIdx  + 1] : undefined;
  const minQuality  = (qualityIdx >= 0 ? args[qualityIdx + 1] : 'high') as LabelQuality;

  const dbPath = process.env['ORACLE_STATE_DB_PATH'] ?? './oracle-state.db';

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    console.error(`[eval:export] could not open DB at ${dbPath}:`, (err as Error).message);
    process.exit(1);
  }

  const { cases, summary } = exportEvalCases(db, minQuality);
  db.close();

  const jsonl = cases.map(c => JSON.stringify(c)).join('\n');

  if (outputPath) {
    writeFileSync(outputPath, jsonl + (cases.length > 0 ? '\n' : ''));
    console.error(`[eval:export] wrote ${cases.length} cases to ${outputPath}`);
  } else {
    if (cases.length > 0) process.stdout.write(jsonl + '\n');
  }

  // Always print summary to stderr
  console.error('[eval:export] summary:');
  console.error(`  feedback rows seen: ${summary.feedbackRowsSeen}`);
  console.error(`  exported cases:     ${summary.exportedCases}`);
  console.error(`  skipped:            ${summary.skippedCases}`);
  if (Object.keys(summary.skipReasons).length > 0) {
    console.error('  skip reasons:');
    for (const [reason, count] of Object.entries(summary.skipReasons)) {
      console.error(`    ${reason}: ${count}`);
    }
  }
  if (Object.keys(summary.casesByEvidenceSource).length > 0) {
    console.error('  cases by evidence source:');
    for (const [src, count] of Object.entries(summary.casesByEvidenceSource)) {
      console.error(`    ${src}: ${count}`);
    }
  }
}

// Only run as CLI when this file is the entry point.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
