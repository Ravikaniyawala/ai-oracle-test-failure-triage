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

  it('accepts expected test names when count and order match', () => {
    const result = validateTriageApiResponse(
      {
        results: [
          VALID_RESULT,
          { ...VALID_RESULT, testName: 'Other > test', category: 'FLAKY', confidence: 0.5 },
        ],
      },
      ['Login > should redirect after auth', 'Other > test'],
    );
    assert.equal(result.results.length, 2);
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

describe('validateTriageApiResponse — expected failure alignment', () => {
  it('throws when the model returns too few results', () => {
    assert.throws(
      () => validateTriageApiResponse(
        { results: [VALID_RESULT] },
        ['Login > should redirect after auth', 'Other > test'],
      ),
      /result count mismatch: expected 2, got 1/,
    );
  });

  it('re-zips results in the expected order when the model returns a permutation', () => {
    // Downstream zips by index, so we must return results in the expected
    // order. Tolerating a permutation (instead of throwing) prevents one
    // model deviation from invalidating an entire 10-failure batch.
    const result = validateTriageApiResponse(
      {
        results: [
          { ...VALID_RESULT, testName: 'Other > test',                       category: 'FLAKY'      },
          { ...VALID_RESULT, testName: 'Login > should redirect after auth', category: 'REGRESSION' },
        ],
      },
      ['Login > should redirect after auth', 'Other > test'],
    );
    assert.equal(result.results[0]!.testName, 'Login > should redirect after auth');
    assert.equal(result.results[0]!.category, 'REGRESSION');
    assert.equal(result.results[1]!.testName, 'Other > test');
    assert.equal(result.results[1]!.category, 'FLAKY');
  });

  it('throws when the model omits a classification for an expected testName', () => {
    // Same count, but the test name set differs — one expected name is
    // missing and an unexpected name was returned in its place. This is the
    // genuine wrong-attribution risk that strict validation must catch.
    assert.throws(
      () => validateTriageApiResponse(
        {
          results: [
            { ...VALID_RESULT, testName: 'Login > should redirect after auth' },
            { ...VALID_RESULT, testName: 'Bogus > unknown test' },
          ],
        },
        ['Login > should redirect after auth', 'Other > test'],
      ),
      /missing classification for testName "Other > test"/,
    );
  });

  it('throws when the model returns duplicate testNames', () => {
    // Two model items claiming the same input is unrecoverable — we can't
    // decide which classification to keep. By the count check, a duplicate
    // also implies an expected name was dropped.
    assert.throws(
      () => validateTriageApiResponse(
        {
          results: [
            { ...VALID_RESULT, testName: 'Login > should redirect after auth' },
            { ...VALID_RESULT, testName: 'Login > should redirect after auth' },
          ],
        },
        ['Login > should redirect after auth', 'Other > test'],
      ),
      /duplicate testName "Login > should redirect after auth"/,
    );
  });

  // Playwright can produce duplicate test titles across projects, retries, or
  // parameterized cases. When `expectedTestNames` itself contains duplicates,
  // the name → item map is ambiguous: one model item would silently be reused
  // for multiple expected slots. The validator must fall back to strict
  // positional alignment, which is the only safe option since the downstream
  // zip in src/triage.ts is positional.
  it('preserves order alignment when expectedTestNames has duplicates and model is in input order', () => {
    // Two failures with the same testName (e.g. same test in two projects).
    // Model returns them positionally — strict path must accept this.
    const result = validateTriageApiResponse(
      {
        results: [
          { ...VALID_RESULT, testName: 'Suite > flaky', category: 'FLAKY'      },
          { ...VALID_RESULT, testName: 'Suite > flaky', category: 'REGRESSION' },
        ],
      },
      ['Suite > flaky', 'Suite > flaky'],
    );
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0]!.category, 'FLAKY');
    assert.equal(result.results[1]!.category, 'REGRESSION');
  });

  it('throws strict-order error (not silent reuse) when expectedTestNames has duplicates and model reorders', () => {
    // Same duplicate-name input, but model swaps the two items. Without the
    // duplicate-aware fallback, the name-map path would have looked up
    // 'Suite > flaky' twice and silently reused whichever item the map
    // happened to keep — assigning the same category to both failures.
    // With the fallback, the strict positional check fires.
    assert.throws(
      () => validateTriageApiResponse(
        {
          results: [
            { ...VALID_RESULT, testName: 'Suite > different', category: 'FLAKY' },
            { ...VALID_RESULT, testName: 'Suite > flaky',     category: 'REGRESSION' },
          ],
        },
        ['Suite > flaky', 'Suite > flaky'],
      ),
      /result order mismatch.*duplicate testNames/s,
    );
  });

  it('does NOT silently reuse one model item for multiple expected slots when duplicates exist', () => {
    // Sanity: even if the model returns two items both matching the duplicate
    // name but in the wrong INNER order (e.g. wrong category for slot 0),
    // strict positional alignment preserves that — we never quietly pick one
    // item to stand in for two slots.
    const result = validateTriageApiResponse(
      {
        results: [
          { ...VALID_RESULT, testName: 'Suite > flaky', category: 'NEW_BUG'    },
          { ...VALID_RESULT, testName: 'Suite > flaky', category: 'ENV_ISSUE'  },
        ],
      },
      ['Suite > flaky', 'Suite > flaky'],
    );
    // Both slots distinct, no reuse — categories preserved positionally.
    assert.notStrictEqual(result.results[0], result.results[1]);
    assert.equal(result.results[0]!.category, 'NEW_BUG');
    assert.equal(result.results[1]!.category, 'ENV_ISSUE');
  });
});
