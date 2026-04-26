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
 *   4. If expectedTestNames is provided:
 *      a. count must match the input
 *      b. the SET of testNames must match the input (no duplicates,
 *         no missing, no extras)
 *      c. results are returned in the expectedTestNames ORDER, re-zipping
 *         the model's output if it returned a permutation. The downstream
 *         consumer (`src/triage.ts`) zips by index against the input
 *         failures array, so a reorder would mis-attribute categories;
 *         silently re-zipping prevents that without aborting the whole
 *         batch on a model deviation. Duplicate testNames in the model's
 *         output trip the set check (a duplicate by definition means
 *         another expected name is missing).
 */
export function validateTriageApiResponse(
  raw: unknown,
  expectedTestNames?: readonly string[],
): TriageApiResponse {
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

  const parsed = result.data;

  if (expectedTestNames !== undefined) {
    if (parsed.results.length !== expectedTestNames.length) {
      throw new TriageValidationError(
        `LLM response result count mismatch: expected ${expectedTestNames.length}, got ${parsed.results.length}`,
      );
    }

    // Detect duplicate test names in the INPUT. Playwright can produce
    // duplicate titles across projects, retries, or parameterized cases —
    // when that happens, the name → item map below is ambiguous (one model
    // item would silently be reused for multiple expected slots). In that
    // case fall back to strict positional validation: the model MUST
    // return results in input order. The downstream zip in src/triage.ts
    // is positional anyway, so strict order is the only safe alignment
    // when names are not unique.
    const expectedNameCounts = new Map<string, number>();
    for (const name of expectedTestNames) {
      expectedNameCounts.set(name, (expectedNameCounts.get(name) ?? 0) + 1);
    }
    const hasDuplicateExpected = [...expectedNameCounts.values()].some(c => c > 1);

    if (hasDuplicateExpected) {
      for (let i = 0; i < expectedTestNames.length; i++) {
        const expected = expectedTestNames[i]!;
        const actual   = parsed.results[i]!.testName;
        if (actual !== expected) {
          throw new TriageValidationError(
            `LLM response result order mismatch at results.${i}.testName: expected "${expected}", got "${actual}" ` +
            `(strict order required because the input batch contains duplicate testNames)`,
          );
        }
      }
      return parsed;
    }

    // Unique-name path — build a name → item map. Duplicate testNames in
    // the MODEL response are rejected outright: they would mean two model
    // entries claim the same input, and we cannot decide which
    // classification to keep.
    const byName = new Map<string, TriageApiResponse['results'][number]>();
    for (const item of parsed.results) {
      if (byName.has(item.testName)) {
        throw new TriageValidationError(
          `LLM response contains duplicate testName "${item.testName}"`,
        );
      }
      byName.set(item.testName, item);
    }

    // Re-zip in the expected order. Any expected name not in the map is a
    // missing-classification error; the count check above guarantees that
    // a missing name implies an extra unexpected name was returned in its
    // place.
    const reordered: TriageApiResponse['results'] = [];
    for (let i = 0; i < expectedTestNames.length; i++) {
      const expected = expectedTestNames[i]!;
      const item = byName.get(expected);
      if (item === undefined) {
        throw new TriageValidationError(
          `LLM response missing classification for testName "${expected}" (expected at results.${i})`,
        );
      }
      reordered.push(item);
    }

    return { results: reordered };
  }

  return parsed;
}
