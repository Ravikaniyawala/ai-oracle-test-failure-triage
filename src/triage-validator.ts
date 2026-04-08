import { TriageCategory, type TriageApiResponse } from './types.js';

const VALID_CATEGORIES = new Set<string>(Object.values(TriageCategory));

function isValidCategory(value: unknown): value is TriageCategory {
  return typeof value === 'string' && VALID_CATEGORIES.has(value);
}

function isValidConfidence(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Validate and narrow a raw parsed value to TriageApiResponse.
 *
 * Throws with a descriptive message on any structural or value violation.
 * Callers (triage.ts) must catch — never pass unvalidated LLM output to
 * the policy engine.
 *
 * Validated per result item:
 *   testName      — non-empty string
 *   category      — one of FLAKY | REGRESSION | ENV_ISSUE | NEW_BUG
 *   confidence    — finite number in [0, 1]
 *   reasoning     — string
 *   suggested_fix — string
 */
export function validateTriageApiResponse(raw: unknown): TriageApiResponse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('LLM response is not a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj['results'])) {
    throw new Error('LLM response missing "results" array');
  }

  const results = (obj['results'] as unknown[]).map((item, idx) => {
    const prefix = `LLM result[${idx}]`;

    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`${prefix} is not an object`);
    }

    const r = item as Record<string, unknown>;

    if (typeof r['testName'] !== 'string' || r['testName'] === '') {
      throw new Error(`${prefix} missing or empty string field: testName`);
    }
    if (!isValidCategory(r['category'])) {
      throw new Error(
        `${prefix} has invalid category: "${String(r['category'])}" ` +
        `(must be one of ${[...VALID_CATEGORIES].join(', ')})`,
      );
    }
    if (!isValidConfidence(r['confidence'])) {
      throw new Error(
        `${prefix} has invalid confidence: ${String(r['confidence'])} ` +
        `(must be a finite number in [0, 1])`,
      );
    }
    if (typeof r['reasoning'] !== 'string') {
      throw new Error(`${prefix} missing string field: reasoning`);
    }
    if (typeof r['suggested_fix'] !== 'string') {
      throw new Error(`${prefix} missing string field: suggested_fix`);
    }

    return {
      testName:      r['testName']      as string,
      category:      r['category']      as TriageCategory,
      confidence:    r['confidence']    as number,
      reasoning:     r['reasoning']     as string,
      suggested_fix: r['suggested_fix'] as string,
    };
  });

  return { results };
}
