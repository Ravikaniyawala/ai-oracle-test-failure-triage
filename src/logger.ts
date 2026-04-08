/**
 * Minimal structured logger for Oracle validation and ingestion events.
 *
 * Produces `[oracle:<module>] <event>  key=value key=value` lines.
 *
 * This format is:
 *   - Human-readable in CI terminal output
 *   - Parseable by common log aggregators (Datadog, Splunk, CloudWatch Insights)
 *   - Safe: field values are truncated at MAX_VALUE_LENGTH characters so raw
 *     LLM payloads or agent proposal JSON are never accidentally echoed in full
 *
 * Scope: intended for validation and ingestion paths only. General operational
 * logging in index.ts and other modules continues to use console directly with
 * the `[oracle]` prefix — this logger is not a global replacement.
 *
 * Usage:
 *   import { oracleLog } from './logger.js';
 *   oracleLog.warn('agent-proposal-loader', 'proposal.rejected', {
 *     reason: 'schema_validation',
 *     source: 'flaky-detector-v1',
 *     issues: 'proposal_type: must be one of retry_test, request_human_review',
 *   });
 *
 * Output:
 *   [oracle:agent-proposal-loader] proposal.rejected  reason=schema_validation source=flaky-detector-v1 issues="proposal_type: must be one of …"
 */

/** Maximum characters allowed per field value before truncation. */
const MAX_VALUE_LENGTH = 200;

/** Structured fields accepted alongside an event name. */
export type LogFields = Record<string, string | number | boolean | undefined>;

function formatValue(v: string | number | boolean): string {
  const s    = String(v);
  const safe = s.length > MAX_VALUE_LENGTH ? `${s.slice(0, MAX_VALUE_LENGTH)}…` : s;
  // Quote values that contain spaces, equals signs, or quotes to keep key=value parseable.
  return /[ ="']/.test(safe) ? `"${safe.replace(/"/g, "'")}"` : safe;
}

function formatLine(module: string, event: string, fields?: LogFields): string {
  const prefix = `[oracle:${module}] ${event}`;
  if (!fields) return prefix;

  const pairs = Object.entries(fields)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([k, v]) => `${k}=${formatValue(v)}`);

  return pairs.length > 0 ? `${prefix}  ${pairs.join(' ')}` : prefix;
}

export const oracleLog = {
  info(module: string, event: string, fields?: LogFields): void {
    console.log(formatLine(module, event, fields));
  },
  warn(module: string, event: string, fields?: LogFields): void {
    console.warn(formatLine(module, event, fields));
  },
  error(module: string, event: string, fields?: LogFields): void {
    console.error(formatLine(module, event, fields));
  },
};
