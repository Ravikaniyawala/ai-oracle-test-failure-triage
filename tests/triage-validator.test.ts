import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateTriageApiResponse, TriageValidationError } from '../src/triage-validator.js';

// A complete, valid result item matching the prompt schema.
const VALID_RESULT = {
  testName:      'Login > should redirect after auth',
  category:      'REGRESSION',
  confidence:    0.9,
  reasoning:     'Endpoint returned 401 instead of 302',
  suggested_fix: 'Check auth middleware session handling',
};

const VALID_RESPONSE = { results: [VALID_RESULT] };

// ---------------------------------------------------------------------------
// Valid input — must be accepted without throwing
// ---------------------------------------------------------------------------

describe('validateTriageApiResponse — valid input', () => {
  it('accepts a well-formed single-result response', () => {
    const result = validateTriageApiResponse(VALID_RESPONSE);
    assert.equal(result.results.length, 1);
    const r = result.results[0]!;
    assert.equal(r.testName,      'Login > should redirect after auth');
    assert.equal(r.category,      'REGRESSION');
    assert.equal(r.confidence,    0.9);
    assert.equal(r.reasoning,     'Endpoint returned 401 instead of 302');
    assert.equal(r.suggested_fix, 'Check auth middleware session handling');
  });

  it('accepts all four valid categories', () => {
    for (const category of ['FLAKY', 'REGRESSION', 'ENV_ISSUE', 'NEW_BUG']) {
      const result = validateTriageApiResponse({ results: [{ ...VALID_RESULT, category }] });
      assert.equal(result.results[0]!.category, category);
    }
  });

  it('accepts confidence boundary value 0', () => {
    const result = validateTriageApiResponse({ results: [{ ...VALID_RESULT, confidence: 0 }] });
    assert.equal(result.results[0]!.confidence, 0);
  });

  it('accepts confidence boundary value 1', () => {
    const result = validateTriageApiResponse({ results: [{ ...VALID_RESULT, confidence: 1 }] });
    assert.equal(result.results[0]!.confidence, 1);
  });

  it('accepts an empty results array', () => {
    const result = validateTriageApiResponse({ results: [] });
    assert.equal(result.results.length, 0);
  });

  it('accepts multiple results', () => {
    const result = validateTriageApiResponse({
      results: [
        VALID_RESULT,
        { ...VALID_RESULT, testName: 'Other > test', category: 'FLAKY', confidence: 0.5 },
      ],
    });
    assert.equal(result.results.length, 2);
    assert.equal(result.results[1]!.category, 'FLAKY');
  });

  it('ignores unknown extra fields in the response root', () => {
    const result = validateTriageApiResponse({ results: [VALID_RESULT], extra_field: true });
    assert.equal(result.results.length, 1);
  });

  it('throws TriageValidationError (not a generic Error) on invalid input', () => {
    assert.throws(
      () => validateTriageApiResponse(null),
      (err: unknown) => err instanceof TriageValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid root structure (pre-checks) — messages must stay stable for callers
// ---------------------------------------------------------------------------

describe('validateTriageApiResponse — invalid root structure', () => {
  it('throws for null input', () => {
    assert.throws(
      () => validateTriageApiResponse(null),
      /not a JSON object/,
    );
  });

  it('throws for array input', () => {
    assert.throws(
      () => validateTriageApiResponse([VALID_RESPONSE]),
      /not a JSON object/,
    );
  });

  it('throws for string input', () => {
    assert.throws(
      () => validateTriageApiResponse('{"results":[]}'),
      /not a JSON object/,
    );
  });

  it('throws for number input', () => {
    assert.throws(
      () => validateTriageApiResponse(42),
      /not a JSON object/,
    );
  });

  it('throws when results key is missing', () => {
    assert.throws(
      () => validateTriageApiResponse({}),
      /missing "results" array/,
    );
  });

  it('throws when results is an object, not an array', () => {
    assert.throws(
      () => validateTriageApiResponse({ results: { 0: VALID_RESULT } }),
      /missing "results" array/,
    );
  });

  it('throws when results is null', () => {
    assert.throws(
      () => validateTriageApiResponse({ results: null }),
      /missing "results" array/,
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid result items — Zod validates field-by-field, errors include dot-path
// Error format: "LLM response failed schema validation:\n  results.N.field: msg"
// ---------------------------------------------------------------------------

describe('validateTriageApiResponse — invalid result fields', () => {
  it('throws for unknown category string', () => {
    assert.throws(
      () => validateTriageApiResponse({ results: [{ ...VALID_RESULT, category: 'BUG' }] }),
      /results\.0\.category/,
    );
  });

  it('throws for missing category', () => {
    const { category: _, ...rest } = VALID_RESULT;
    assert.throws(
      () => validateTriageApiResponse({ results: [rest] }),
      /results\.0\.category/,
    );
  });

  it('throws for lowercase category', () => {
    assert.throws(
      () => validateTriageApiResponse({ results: [{ ...VALID_RESULT, category: 'regression' }] }),
      /results\.0\.category/,
    );
  });

  it('throws for a non-object result item (string)', () => {
    assert.throws(
      () => validateTriageApiResponse({ results: ['REGRESSION'] }),
      /results\.0/,
    );
  });

  it('throws for a null result item', () => {
    assert.throws(
      () => validateTriageApiResponse({ results: [null] }),
      /results\.0/,
    );
  });

  it('throws for confidence above 1', () => {
    assert.throws(
      () => validateTriageApiResponse({ results: [{ ...VALID_RESULT, confidence: 1.1 }] }),
      /results\.0\.confidence/,
    );
  });

  it('throws for confidence below 0', () => {
    assert.throws(
      () => validateTriageApiResponse({ results: [{ ...VALID_RESULT, confidence: -0.1 }] }),
      /results\.0\.confidence/,
    );
  });

  it('throws for NaN confidence', () => {
    assert.throws(
      () => validateTriageApiResponse({ results: [{ ...VALID_RESULT, confidence: NaN }] }),
      /results\.0\.confidence/,
    );
  });

  it('throws for Infinity confidence', () => {
    assert.throws(
      () => validateTriageApiResponse({ results: [{ ...VALID_RESULT, confidence: Infinity }] }),
      /results\.0\.confidence/,
    );
  });

  it('throws for string confidence', () => {
    assert.throws(
      () => validateTriageApiResponse({ results: [{ ...VALID_RESULT, confidence: '0.9' }] }),
      /results\.0\.confidence/,
    );
  });

  it('throws for missing reasoning', () => {
    const { reasoning: _, ...rest } = VALID_RESULT;
    assert.throws(
      () => validateTriageApiResponse({ results: [rest] }),
      /results\.0\.reasoning/,
    );
  });

  it('throws for non-string reasoning', () => {
    assert.throws(
      () => validateTriageApiResponse({ results: [{ ...VALID_RESULT, reasoning: 42 }] }),
      /results\.0\.reasoning/,
    );
  });

  it('throws for missing suggested_fix', () => {
    const { suggested_fix: _, ...rest } = VALID_RESULT;
    assert.throws(
      () => validateTriageApiResponse({ results: [rest] }),
      /results\.0\.suggested_fix/,
    );
  });

  it('throws for empty testName', () => {
    assert.throws(
      () => validateTriageApiResponse({ results: [{ ...VALID_RESULT, testName: '' }] }),
      /results\.0\.testName/,
    );
  });

  it('throws for missing testName', () => {
    const { testName: _, ...rest } = VALID_RESULT;
    assert.throws(
      () => validateTriageApiResponse({ results: [rest] }),
      /results\.0\.testName/,
    );
  });

  it('error message includes the result index for the failing item', () => {
    assert.throws(
      () => validateTriageApiResponse({
        results: [VALID_RESULT, { ...VALID_RESULT, category: 'INVALID' }],
      }),
      /results\.1\.category/,
    );
  });

  it('error message contains "schema validation" for field-level errors', () => {
    assert.throws(
      () => validateTriageApiResponse({ results: [{ ...VALID_RESULT, category: 'INVALID' }] }),
      /schema validation/,
    );
  });
});
