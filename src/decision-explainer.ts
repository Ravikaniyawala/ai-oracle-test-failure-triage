import { type PatternStats } from './types.js';

/**
 * Format a decision into a compact, human-readable single-line explanation.
 * Used in CI logs, oracle-decision-summary.md, and Slack highlights.
 *
 * Examples:
 *   create_jira rejected — history:duplicate_pattern (jira_created=3, jira_duplicates=2)
 *   retry_test approved — history:retry_success_pattern (retry_passed=3, retry_failed=1)
 *   create_jira rejected — history:jira_already_created
 *   notify_slack approved — policy:auto-approved
 */
export function explainDecision(
  actionType: string,
  verdict:    string,
  reason:     string,
  stats?:     PatternStats,
): string {
  const base    = `${actionType} ${verdict} — ${reason}`;
  const context = statsContext(reason, stats);
  return context ? `${base} (${context})` : base;
}

/**
 * Returns true when a decision is worth surfacing in CI logs or summary output.
 *
 * Notable means:
 *   - rejected or held   → something was blocked or deferred; operator should know why
 *   - history-influenced → system used past data to change the default outcome
 *
 * Auto-approved policy actions (policy:auto-approved) are intentionally excluded
 * to keep logs readable.
 */
export function isNotable(verdict: string, reason: string): boolean {
  if (verdict === 'rejected') return true;
  if (verdict === 'held')     return true;
  if (reason.startsWith('history:')) return true;
  return false;
}

/**
 * Build the parenthetical stats context appended to a history-influenced explanation.
 * Returns an empty string for reasons that carry no useful stat context.
 */
function statsContext(reason: string, stats?: PatternStats): string {
  if (!stats) return '';

  if (reason === 'history:duplicate_pattern') {
    return `jira_created=${stats.jiraCreatedCount}, jira_duplicates=${stats.jiraDuplicateCount}`;
  }

  if (
    reason === 'history:retry_success_pattern' ||
    reason === 'history:retry_failure_pattern'
  ) {
    return `retry_passed=${stats.retryPassedCount}, retry_failed=${stats.retryFailedCount}`;
  }

  return '';
}
