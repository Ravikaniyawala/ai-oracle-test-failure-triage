import { ZodError, type ZodIssue } from 'zod';
import { TriageApiResponseSchema } from './schemas.js';
import { type TriageApiResponse } from './types.js';

/**
 * Thrown when the LLM response does not conform to the triage output schema.
 * Callers can use `instanceof TriageValidationError` to distinguish a
 * malformed LLM response from an API transport error or network failure.
 */
export class TriageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TriageValidationError';
  }
}

/**
 * Format a ZodError into a compact, multi-line string for structured logging.
 *
 * Each issue is rendered as "  <dot.path>: <message>" so the log line is
 * actionable without including the raw LLM payload (which may contain
 * sensitive test names, stack traces, or PII).
 *
 * Example output:
 *   results.0.category: Invalid enum value. Expected 'FLAKY' | …, received 'BUG'
 *   results.1.confidence: confidence must be <= 1
 */
function formatZodIssues(err: ZodError): string {
  return err.issues
    .map((e: ZodIssue) => {
      const path = e.path.length > 0 ? e.path.map(String).join('.') : '(root)';
      return `  ${path}: ${e.message}`;
    })
    .join('\n');
}

/**
 * Validate and narrow a raw parsed value to TriageApiResponse.
 *
 * Throws TriageValidationError with field-level context on any violation.
 * Never throws for a valid response.  Callers must catch before passing
 * the result to the policy engine.
 *
 * Validation order:
 *   1. Root must be a plain object (pre-check — cleaner message than Zod default)
 *   2. "results" key must be an array (pre-check)
 *   3. Every result item validated by TriageResultItemSchema via Zod
 *      — category must be FLAKY | REGRESSION | ENV_ISSUE | NEW_BUG
 *      — confidence must be a finite number in [0, 1]
 *      — testName must be a non-empty string
 *      — reasoning and suggested_fix must be strings
 */
export function validateTriageApiResponse(raw: unknown): TriageApiResponse {
  // Pre-checks give cleaner error messages for the two most common
  // structural violations before handing off to Zod for field-level checks.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TriageValidationError('LLM response is not a JSON object');
  }

  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj['results'])) {
    throw new TriageValidationError('LLM response missing "results" array');
  }

  const result = TriageApiResponseSchema.safeParse(raw);
  if (!result.success) {
    throw new TriageValidationError(
      `LLM response failed schema validation:\n${formatZodIssues(result.error)}`,
    );
  }

  return result.data;
}
