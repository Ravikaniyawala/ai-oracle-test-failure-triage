import { readFileSync } from 'fs';
import { saveFeedback } from './state-store.js';
import { type FeedbackEntry, type FeedbackType } from './types.js';
import { oracleLog } from './logger.js';

// Raw JSON shape (snake_case, as documented in the spec)
interface RawFeedback {
  feedback_type:       string;
  pipeline_id?:        string;
  test_name?:          string;
  error_hash?:         string;
  action_fingerprint?: string;
  old_value?:          string;
  new_value?:          string;
  notes?:              string;
}

const VALID_TYPES = new Set<string>([
  'jira_closed_duplicate',
  'jira_closed_confirmed',
  'classification_corrected',
  'action_overridden',
  'retry_passed',
  'retry_failed',
]);

function isValidFeedback(raw: unknown): raw is RawFeedback {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return typeof r['feedback_type'] === 'string' && VALID_TYPES.has(r['feedback_type']);
}

function toEntry(raw: RawFeedback): FeedbackEntry {
  return {
    feedbackType:       raw.feedback_type as FeedbackType,
    pipelineId:         raw.pipeline_id,
    testName:           raw.test_name,
    errorHash:          raw.error_hash,
    actionFingerprint:  raw.action_fingerprint,
    oldValue:           raw.old_value,
    newValue:           raw.new_value,
    notes:              raw.notes,
    createdAt:          new Date().toISOString(),
  };
}

/**
 * Read a JSON file containing one feedback object or an array of them,
 * validate each entry, and persist to the feedback table.
 *
 * Returns the number of entries successfully saved.
 * Invalid entries are warned and skipped — they do not abort the batch.
 */
export function ingestFeedback(filePath: string): number {
  const text = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(text) as unknown;
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

  let saved = 0;
  for (const item of items) {
    if (!isValidFeedback(item)) {
      // Log the rejection without echoing the raw payload (may contain sensitive test names or PII).
      const feedbackType =
        typeof item === 'object' && item !== null && 'feedback_type' in item
          ? String((item as Record<string, unknown>)['feedback_type'])
          : '(missing)';
      oracleLog.warn('feedback-processor', 'feedback.rejected', {
        reason:        'invalid_or_unknown_type',
        feedback_type: feedbackType,
      });
      continue;
    }
    saveFeedback(toEntry(item));
    saved++;
  }
  return saved;
}
