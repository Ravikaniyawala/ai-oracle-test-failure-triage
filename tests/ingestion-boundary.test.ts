/**
 * Integration-style boundary tests for the full ingestion-to-validation path.
 *
 * These tests exercise the complete chain from raw JSON input through
 * schema validation and into the typed domain objects, without mocking
 * the validation layer. They complement the unit tests in:
 *   - triage-validator.test.ts   (LLM output validation)
 *   - agent-proposal-loader.test.ts  (proposal file loading + rate limiting)
 *
 * Coverage targets:
 *   1. validateTriageApiResponse — happy path and all rejection branches
 *   2. loadAgentProposals — all rejection branches produce empty results
 *   3. Cross-cutting: field values are preserved end-to-end through the chain
 *   4. Boundary values (confidence = 0, 1; empty strings for optional fields)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { after } from 'node:test';

import { validateTriageApiResponse, TriageValidationError } from '../src/triage-validator.js';
import { loadAgentProposals } from '../src/agent-proposal-loader.js';
import { TriageCategory } from '../src/types.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const tmp = join(tmpdir(), 'oracle-ingestion-boundary-test');
mkdirSync(tmp, { recursive: true });
after(() => rmSync(tmp, { recursive: true, force: true }));

function writeJson(name: string, content: unknown): string {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

const VALID_TRIAGE_ITEM = {
  testName:      'checkout > applies voucher',
  category:      'FLAKY',
  confidence:    0.85,
  reasoning:     'Selector timeout pattern matches known flaky selector',
  suggested_fix: 'Add waitForSelector before interacting with voucher input',
};

const VALID_PROPOSAL = {
  source_agent:  'flaky-detector-v1',
  proposal_type: 'retry_test',
  pipeline_id:   'pipe-999',
  test_name:     'checkout > applies voucher',
  error_hash:    'deadbeef',
  confidence:    0.85,
  reasoning:     'High confidence flaky match',
  payload:       { attempt: 1 },
};

// ── validateTriageApiResponse ─────────────────────────────────────────────────

describe('ingestion boundary — validateTriageApiResponse', () => {
  it('accepts a well-formed response and preserves all fields', () => {
    const raw = { results: [VALID_TRIAGE_ITEM] };
    const response = validateTriageApiResponse(raw);
    assert.equal(response.results.length, 1);
    const item = response.results[0]!;
    assert.equal(item.testName,      'checkout > applies voucher');
    assert.equal(item.category,      TriageCategory.FLAKY);
    assert.equal(item.confidence,    0.85);
    assert.equal(item.reasoning,     'Selector timeout pattern matches known flaky selector');
    assert.equal(item.suggested_fix, 'Add waitForSelector before interacting with voucher input');
  });

  it('accepts all four valid categories', () => {
    const categories = ['FLAKY', 'REGRESSION', 'ENV_ISSUE', 'NEW_BUG'];
    for (const category of categories) {
      const raw = { results: [{ ...VALID_TRIAGE_ITEM, category }] };
      const response = validateTriageApiResponse(raw);
      assert.equal(response.results[0]!.category, category as TriageCategory);
    }
  });

  it('accepts confidence = 0 (lower boundary)', () => {
    const raw = { results: [{ ...VALID_TRIAGE_ITEM, confidence: 0 }] };
    const response = validateTriageApiResponse(raw);
    assert.equal(response.results[0]!.confidence, 0);
  });

  it('accepts confidence = 1 (upper boundary)', () => {
    const raw = { results: [{ ...VALID_TRIAGE_ITEM, confidence: 1 }] };
    const response = validateTriageApiResponse(raw);
    assert.equal(response.results[0]!.confidence, 1);
  });

  it('accepts empty string for reasoning (not required to be non-empty)', () => {
    const raw = { results: [{ ...VALID_TRIAGE_ITEM, reasoning: '' }] };
    const response = validateTriageApiResponse(raw);
    assert.equal(response.results[0]!.reasoning, '');
  });

  it('accepts empty string for suggested_fix (not required to be non-empty)', () => {
    const raw = { results: [{ ...VALID_TRIAGE_ITEM, suggested_fix: '' }] };
    const response = validateTriageApiResponse(raw);
    assert.equal(response.results[0]!.suggested_fix, '');
  });

  it('accepts an empty results array', () => {
    const raw = { results: [] };
    const response = validateTriageApiResponse(raw);
    assert.equal(response.results.length, 0);
  });

  it('accepts multiple result items', () => {
    const raw = {
      results: [
        VALID_TRIAGE_ITEM,
        { ...VALID_TRIAGE_ITEM, testName: 'login > redirect', category: 'REGRESSION', confidence: 0.92 },
      ],
    };
    const response = validateTriageApiResponse(raw);
    assert.equal(response.results.length, 2);
  });

  // ── Rejection branches ───────────────────────────────────────────────────

  it('rejects null — throws TriageValidationError', () => {
    assert.throws(
      () => validateTriageApiResponse(null),
      (err: unknown) => err instanceof TriageValidationError && /not a JSON object/.test(err.message),
    );
  });

  it('rejects a plain array — throws TriageValidationError', () => {
    assert.throws(
      () => validateTriageApiResponse([VALID_TRIAGE_ITEM]),
      (err: unknown) => err instanceof TriageValidationError && /not a JSON object/.test(err.message),
    );
  });

  it('rejects a string — throws TriageValidationError', () => {
    assert.throws(
      () => validateTriageApiResponse('{"results":[]}'),
      (err: unknown) => err instanceof TriageValidationError,
    );
  });

  it('rejects an object missing "results" key — throws TriageValidationError', () => {
    assert.throws(
      () => validateTriageApiResponse({ data: [] }),
      (err: unknown) => err instanceof TriageValidationError && /missing "results" array/.test(err.message),
    );
  });

  it('rejects when "results" is not an array — throws TriageValidationError', () => {
    assert.throws(
      () => validateTriageApiResponse({ results: 'oops' }),
      (err: unknown) => err instanceof TriageValidationError && /missing "results" array/.test(err.message),
    );
  });

  it('rejects an invalid category — includes path in error message', () => {
    const raw = { results: [{ ...VALID_TRIAGE_ITEM, category: 'UNKNOWN_CATEGORY' }] };
    assert.throws(
      () => validateTriageApiResponse(raw),
      (err: unknown) => {
        if (!(err instanceof TriageValidationError)) return false;
        return err.message.includes('schema validation') && err.message.includes('category');
      },
    );
  });

  it('rejects confidence > 1 — includes path in error message', () => {
    const raw = { results: [{ ...VALID_TRIAGE_ITEM, confidence: 1.1 }] };
    assert.throws(
      () => validateTriageApiResponse(raw),
      (err: unknown) => {
        if (!(err instanceof TriageValidationError)) return false;
        return err.message.includes('confidence');
      },
    );
  });

  it('rejects confidence < 0 — includes path in error message', () => {
    const raw = { results: [{ ...VALID_TRIAGE_ITEM, confidence: -0.01 }] };
    assert.throws(
      () => validateTriageApiResponse(raw),
      (err: unknown) => err instanceof TriageValidationError && err.message.includes('confidence'),
    );
  });

  it('rejects empty testName — includes path in error message', () => {
    const raw = { results: [{ ...VALID_TRIAGE_ITEM, testName: '' }] };
    assert.throws(
      () => validateTriageApiResponse(raw),
      (err: unknown) => err instanceof TriageValidationError && err.message.includes('testName'),
    );
  });

  it('error message includes dot-path for nested field violations', () => {
    const raw = {
      results: [
        VALID_TRIAGE_ITEM,
        { ...VALID_TRIAGE_ITEM, testName: '', category: 'BAD' },
      ],
    };
    assert.throws(
      () => validateTriageApiResponse(raw),
      (err: unknown) => {
        if (!(err instanceof TriageValidationError)) return false;
        // Should reference the second item: "results.1.testName" or "results.1.category"
        return err.message.includes('results.1');
      },
    );
  });

  it('thrown error is distinguishable from a generic Error', () => {
    assert.throws(
      () => validateTriageApiResponse(null),
      (err: unknown) => {
        if (!(err instanceof TriageValidationError)) return false;
        assert.equal(err.name, 'TriageValidationError');
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });
});

// ── loadAgentProposals — end-to-end field preservation ───────────────────────

describe('ingestion boundary — loadAgentProposals field preservation', () => {
  it('maps all snake_case fields to camelCase correctly', () => {
    const path = writeJson('field-map.json', VALID_PROPOSAL);
    const proposals = loadAgentProposals(path);
    assert.equal(proposals.length, 1);
    const p = proposals[0]!;
    assert.equal(p.sourceAgent,  'flaky-detector-v1');
    assert.equal(p.proposalType, 'retry_test');
    assert.equal(p.pipelineId,   'pipe-999');
    assert.equal(p.testName,     'checkout > applies voucher');
    assert.equal(p.errorHash,    'deadbeef');
    assert.equal(p.confidence,   0.85);
    assert.equal(p.reasoning,    'High confidence flaky match');
    assert.deepEqual(p.payload,  { attempt: 1 });
  });

  it('preserves confidence boundary value 0', () => {
    const path = writeJson('conf-zero.json', { ...VALID_PROPOSAL, confidence: 0 });
    const proposals = loadAgentProposals(path);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.confidence, 0);
  });

  it('preserves confidence boundary value 1', () => {
    const path = writeJson('conf-one.json', { ...VALID_PROPOSAL, confidence: 1 });
    const proposals = loadAgentProposals(path);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.confidence, 1);
  });

  it('accepts both valid proposal_type values', () => {
    const path = writeJson('both-types.json', [
      { ...VALID_PROPOSAL, proposal_type: 'retry_test' },
      { ...VALID_PROPOSAL, proposal_type: 'request_human_review', test_name: 'Other > test' },
    ]);
    const proposals = loadAgentProposals(path);
    assert.equal(proposals.length, 2);
    assert.equal(proposals[0]!.proposalType, 'retry_test');
    assert.equal(proposals[1]!.proposalType, 'request_human_review');
  });
});

// ── loadAgentProposals — rejection at ingestion boundary ─────────────────────

describe('ingestion boundary — loadAgentProposals rejection', () => {
  it('rejects invalid proposal_type before reaching the policy engine', () => {
    const path = writeJson('bad-type.json', { ...VALID_PROPOSAL, proposal_type: 'force_deploy' });
    assert.equal(loadAgentProposals(path).length, 0);
  });

  it('rejects confidence NaN (transmitted as a non-numeric string)', () => {
    const path = writeJson('conf-nan.json', { ...VALID_PROPOSAL, confidence: 'NaN' });
    assert.equal(loadAgentProposals(path).length, 0);
  });

  it('rejects confidence = 1.001 (just above upper bound)', () => {
    const path = writeJson('conf-over.json', { ...VALID_PROPOSAL, confidence: 1.001 });
    assert.equal(loadAgentProposals(path).length, 0);
  });

  it('rejects a completely empty object', () => {
    const path = writeJson('empty-obj.json', {});
    assert.equal(loadAgentProposals(path).length, 0);
  });

  it('rejects when source_agent is an empty string', () => {
    const path = writeJson('empty-source.json', { ...VALID_PROPOSAL, source_agent: '' });
    assert.equal(loadAgentProposals(path).length, 0);
  });

  it('rejects when test_name is an empty string', () => {
    const path = writeJson('empty-testname.json', { ...VALID_PROPOSAL, test_name: '' });
    assert.equal(loadAgentProposals(path).length, 0);
  });

  it('rejects when error_hash is an empty string', () => {
    const path = writeJson('empty-hash.json', { ...VALID_PROPOSAL, error_hash: '' });
    assert.equal(loadAgentProposals(path).length, 0);
  });

  it('accepts valid entry alongside invalid ones — fail-partial not fail-all', () => {
    const path = writeJson('mixed-boundary.json', [
      { ...VALID_PROPOSAL, test_name: 'Valid Test' },
      { ...VALID_PROPOSAL, confidence: 99 },        // out of range
      { ...VALID_PROPOSAL, proposal_type: 'nuke' }, // unknown type
      { ...VALID_PROPOSAL, test_name: 'Also Valid' },
    ]);
    const proposals = loadAgentProposals(path);
    assert.equal(proposals.length, 2);
    assert.equal(proposals[0]!.testName, 'Valid Test');
    assert.equal(proposals[1]!.testName, 'Also Valid');
  });
});
