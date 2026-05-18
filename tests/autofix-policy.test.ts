/**
 * Tests for src/autofix-policy.ts — the safety-critical wiring layer
 * that turns detector output into approved/held/rejected
 * `fix_test_with_agent` decisions.
 *
 * Coverage priorities (matches the design-doc invariants):
 *   1. REGRESSION / NEW_BUG / ENV_ISSUE NEVER produce a proposal
 *      regardless of mode, topology, history, or detector output
 *   2. split_e2e topology forces effectiveMode='propose' (no auto)
 *   3. Mode=off short-circuits everything
 *   4. Hard-negative guards reject before source attribution
 *   5. History rules (fix_decay, repeated-failure) suppress correctly
 *   6. Rate limit holds excess approvals
 *   7. Repairability gating (kind + confidence + auto-eligible set)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideAutofixAction,
  evaluateHardGuards,
  proposeTestFixActions,
  runAutofixPolicy,
  readAutofixModeFromEnv,
  type AutofixMode,
} from '../src/autofix-policy.js';
import { TriageCategory, type ActionProposal, type PatternStats, type TriageResult } from '../src/types.js';
import type { LocatorDriftClassification, RepoTopology, TopologyValidationResult } from '../src/autofix-detector/types.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeResult(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    testName:     'Suite > test',
    errorMessage: `TimeoutError: locator.click: Timeout 5000ms exceeded.\n  - waiting for getByTestId('checkout-btn')`,
    errorHash:    'abc123',
    file:         'tests/e2e/checkout.spec.ts',
    duration:     1000,
    retries:      0,
    category:     TriageCategory.FLAKY,
    confidence:   0.85,
    reasoning:    'r',
    suggestedFix: 'f',
    ...overrides,
  };
}

function makeStats(overrides: Partial<PatternStats> = {}): PatternStats {
  return {
    actionCount:          0,
    jiraCreatedCount:     0,
    jiraDuplicateCount:   0,
    retryPassedCount:     0,
    retryFailedCount:     0,
    agentFixAppliedCount: 0,
    agentFixFailedCount:  0,
    lastAgentFixApplied:  null,
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ActionProposal> = {}): ActionProposal {
  return {
    type:        'fix_test_with_agent',
    scope:       'failure',
    scopeId:     'Suite > test:abc123',
    failureId:   1,
    clusterKey:  null,
    runId:       1,
    pipelineId:  'pipe-1',
    source:      'policy',
    fingerprint: 'fp-fix-1',
    ...overrides,
  };
}

function makeTopology(
  declared: RepoTopology = 'monorepo_e2e',
  state: TopologyValidationResult['state'] = 'full',
  allowsAuto = true,
): { declared: RepoTopology; state: TopologyValidationResult['state']; allowsAuto: boolean } {
  return { declared, state, allowsAuto };
}

function approvableDrift(): LocatorDriftClassification {
  return {
    kind:       'locator_drift_data_testid_only',
    confidence: 0.90,
    reasoning:  'test-attribute drift',
    candidate:  { role: 'button', name: 'Checkout',
                  testAttributes: { 'data-test': 'checkout-button' } },
  };
}

// ── Gate 1: REGRESSION / NEW_BUG / ENV_ISSUE never proposed ──────────────────

describe('proposeTestFixActions — Gate 1 invariant (category)', () => {
  for (const cat of [TriageCategory.REGRESSION, TriageCategory.NEW_BUG, TriageCategory.ENV_ISSUE]) {
    it(`returns [] for ${cat} regardless of mode`, () => {
      for (const mode of ['off', 'propose', 'auto'] as AutofixMode[]) {
        const out = proposeTestFixActions(
          { result: makeResult({ category: cat }), failureId: 1, runId: 1, pipelineId: 'p' },
          mode,
        );
        assert.equal(out.length, 0, `category=${cat} mode=${mode} must produce no proposal`);
      }
    });
  }

  it('returns [] for FLAKY when mode=off', () => {
    const out = proposeTestFixActions(
      { result: makeResult(), failureId: 1, runId: 1, pipelineId: 'p' },
      'off',
    );
    assert.equal(out.length, 0);
  });

  it('returns exactly one fix_test_with_agent proposal for FLAKY + propose', () => {
    const out = proposeTestFixActions(
      { result: makeResult(), failureId: 1, runId: 1, pipelineId: 'p' },
      'propose',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.type, 'fix_test_with_agent');
    assert.equal(out[0]!.scope, 'failure');
  });
});

// ── decideAutofixAction defense-in-depth: even with proposal, REGRESSION rejects

describe('decideAutofixAction — category gate (defense in depth)', () => {
  for (const cat of [TriageCategory.REGRESSION, TriageCategory.NEW_BUG, TriageCategory.ENV_ISSUE]) {
    it(`rejects ${cat} even when proposal was somehow built`, () => {
      const dec = decideAutofixAction({
        proposal:               makeProposal(),
        result:                 makeResult({ category: cat }),
        history:                makeStats(),
        detectorOutput: {
          drift:               approvableDrift(),
          hasAriaSnapshot:     true,
          artifactTrustLevel:  'trusted',
        },
        topology:               makeTopology(),
        alreadyApprovedThisRun: 0,
        maxAutoHealsPerRun:     10,
        effectiveMode:          'auto',
        testRunCount:           100,
      });
      assert.equal(dec.verdict, 'rejected');
      assert.equal(dec.reason, 'category_not_autofix_eligible');
    });
  }
});

// ── Topology invariants ──────────────────────────────────────────────────────

describe('runAutofixPolicy — topology invariants', () => {
  it('split_e2e + mode=auto → effectiveMode becomes propose → held', () => {
    const out = runAutofixPolicy({
      result: makeResult(),
      failureId: 1, runId: 1, pipelineId: 'p',
      history: makeStats(),
      mode: 'auto',
      topology: makeTopology('split_e2e', 'partial', false),
      alreadyApprovedThisRun: 0, maxAutoHealsPerRun: 10,
    });
    assert.ok(out);
    assert.equal(out!.context.effectiveMode, 'propose');
    // No drift signal → routes to hold via repairability_insufficient
    assert.notEqual(out!.decision.verdict, 'approved');
  });

  it('mode=off → returns null (no proposal even built)', () => {
    const out = runAutofixPolicy({
      result: makeResult(),
      failureId: 1, runId: 1, pipelineId: 'p',
      history: makeStats(),
      mode: 'off',
      topology: makeTopology(),
      alreadyApprovedThisRun: 0, maxAutoHealsPerRun: 10,
    });
    assert.equal(out, null);
  });

  it('REGRESSION + topology=full + mode=auto → returns null (Gate 1 wins)', () => {
    const out = runAutofixPolicy({
      result: makeResult({ category: TriageCategory.REGRESSION }),
      failureId: 1, runId: 1, pipelineId: 'p',
      history: makeStats(),
      mode: 'auto',
      topology: makeTopology(),
      alreadyApprovedThisRun: 0, maxAutoHealsPerRun: 10,
    });
    assert.equal(out, null);
  });
});

// ── Hard-negative guards ─────────────────────────────────────────────────────

describe('evaluateHardGuards', () => {
  it('fires value_mismatch on classic assertion-mismatch error', () => {
    const guards = evaluateHardGuards({
      result: makeResult({
        errorMessage: `Error: expect(received).toBe(expected)\n  Expected: 200\n  Received: 404`,
      }),
      effectiveMode: 'auto',
      driftClassification: null,
    });
    assert.ok(guards.includes('value_mismatch'));
  });

  it('fires http_status_mismatch on 4xx/5xx response', () => {
    const guards = evaluateHardGuards({
      result: makeResult({ errorMessage: 'Error: Received: 500 Internal Server Error' }),
      effectiveMode: 'auto',
      driftClassification: null,
    });
    assert.ok(guards.includes('http_status_mismatch'));
  });

  it('fires environment_hard_pin on network error', () => {
    const guards = evaluateHardGuards({
      result: makeResult({ errorMessage: 'Error: getaddrinfo ENOTFOUND api.example.com' }),
      effectiveMode: 'auto',
      driftClassification: null,
    });
    assert.ok(guards.includes('environment_hard_pin'));
  });

  it('fires environment_hard_pin on browser-lifecycle error', () => {
    const guards = evaluateHardGuards({
      result: makeResult({ errorMessage: 'Error: browser has been closed unexpectedly' }),
      effectiveMode: 'auto',
      driftClassification: null,
    });
    assert.ok(guards.includes('environment_hard_pin'));
  });

  it('fires artifact_trust_insufficient_for_auto only in auto mode', () => {
    const auto = evaluateHardGuards({
      result: makeResult(),
      effectiveMode: 'auto',
      artifactTrustLevel: 'partial',
      driftClassification: null,
    });
    assert.ok(auto.includes('artifact_trust_insufficient_for_auto'));

    const propose = evaluateHardGuards({
      result: makeResult(),
      effectiveMode: 'propose',
      artifactTrustLevel: 'partial',
      driftClassification: null,
    });
    assert.ok(!propose.includes('artifact_trust_insufficient_for_auto'));
  });
});

// ── decideAutofixAction routing matrix ────────────────────────────────────────

describe('decideAutofixAction — routing matrix', () => {
  function baseInput(overrides: Parameters<typeof decideAutofixAction>[0] extends infer T ? Partial<T> : never = {}) {
    return {
      proposal:               makeProposal(),
      result:                 makeResult(),
      history:                makeStats(),
      detectorOutput: {
        drift:               approvableDrift(),
        hasAriaSnapshot:     true,
        artifactTrustLevel:  'trusted' as const,
      },
      topology:               makeTopology(),
      alreadyApprovedThisRun: 0,
      maxAutoHealsPerRun:     10,
      effectiveMode:          'auto' as AutofixMode,
      testRunCount:           100,
      ...overrides,
    };
  }

  it('Gate 2 — insufficient history rejects new tests (< 3 runs)', () => {
    const dec = decideAutofixAction(baseInput({ testRunCount: 2 }));
    assert.equal(dec.verdict, 'rejected');
    assert.equal(dec.reason, 'insufficient_history');
  });

  it('Gate 4 — hard-guard wins over source attribution', () => {
    const dec = decideAutofixAction(baseInput({
      result: makeResult({
        errorMessage: `Error: expect(received).toBe(expected)\nReceived: 404\nExpected: 200`,
      }),
    }));
    assert.equal(dec.verdict, 'rejected');
    assert.match(dec.reason, /^hard_negative_/);
  });

  it('Gate 10 — repeated failure pattern rejects after 2+ failed heals', () => {
    const dec = decideAutofixAction(baseInput({
      history: makeStats({ agentFixFailedCount: 3, agentFixAppliedCount: 0 }),
    }));
    assert.equal(dec.verdict, 'rejected');
    assert.equal(dec.reason, 'history:agent_fix_failure_pattern');
  });

  it('Gate 8 — fix decay holds when prior fix was recent', () => {
    const dec = decideAutofixAction(baseInput({
      history: makeStats({
        agentFixAppliedCount: 1,
        lastAgentFixApplied:  new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),  // 1 day ago
      }),
    }));
    assert.equal(dec.verdict, 'held');
    assert.equal(dec.reason, 'history:fix_decay_suspected');
  });

  it('Gate 8 — fix decay does NOT trigger when prior fix was long ago', () => {
    const dec = decideAutofixAction(baseInput({
      history: makeStats({
        agentFixAppliedCount: 1,
        lastAgentFixApplied:  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),  // 30 days ago
      }),
    }));
    assert.equal(dec.verdict, 'approved');
  });

  it('Gate 12 — rate-limit holds excess approvals', () => {
    const dec = decideAutofixAction(baseInput({
      alreadyApprovedThisRun: 10,
      maxAutoHealsPerRun:     10,
    }));
    assert.equal(dec.verdict, 'held');
    assert.equal(dec.reason, 'history:rate_limit_per_run');
  });

  it('Gate 13 — non-AUTO_ELIGIBLE repairability kind holds', () => {
    const dec = decideAutofixAction(baseInput({
      detectorOutput: {
        drift: { kind: 'locator_drift_css_class_only', confidence: 0.9, reasoning: 'css drift' },
        hasAriaSnapshot:    true,
        artifactTrustLevel: 'trusted',
      },
    }));
    assert.equal(dec.verdict, 'held');
    assert.equal(dec.reason, 'repairability_insufficient');
  });

  it('Gate 14 — user-visible-text drift rejects in auto mode', () => {
    const dec = decideAutofixAction(baseInput({
      detectorOutput: {
        drift: { kind: 'locator_drift_user_visible_text', confidence: 0.9, reasoning: 'text changed' },
        hasAriaSnapshot:    true,
        artifactTrustLevel: 'trusted',
      },
    }));
    assert.equal(dec.verdict, 'rejected');
    assert.equal(dec.reason, 'repairability_user_visible_change');
  });

  it('Gate 14 — user-visible-text drift holds in propose mode', () => {
    const dec = decideAutofixAction(baseInput({
      detectorOutput: {
        drift: { kind: 'locator_drift_user_visible_text', confidence: 0.9, reasoning: 'text changed' },
        hasAriaSnapshot:    true,
        artifactTrustLevel: 'trusted',
      },
      effectiveMode: 'propose',
    }));
    assert.equal(dec.verdict, 'held');
  });

  it('Gate 15 — repairability confidence below threshold holds', () => {
    const dec = decideAutofixAction(baseInput({
      detectorOutput: {
        drift: { kind: 'locator_drift_data_testid_only', confidence: 0.5, reasoning: 'low conf' },
        hasAriaSnapshot:    true,
        artifactTrustLevel: 'trusted',
      },
    }));
    assert.equal(dec.verdict, 'held');
    assert.equal(dec.reason, 'repairability_confidence_low');
  });

  it('Gate 18 — mode=propose with all positive signals → held, not approved', () => {
    const dec = decideAutofixAction(baseInput({
      effectiveMode: 'propose',
    }));
    assert.equal(dec.verdict, 'held');
    assert.equal(dec.reason, 'mode_propose');
  });

  it('Gate 19 — full happy path → approved', () => {
    const dec = decideAutofixAction(baseInput());
    assert.equal(dec.verdict, 'approved');
    assert.equal(dec.reason, 'policy:auto-approved');
  });
});

// ── readAutofixModeFromEnv ────────────────────────────────────────────────────

describe('readAutofixModeFromEnv', () => {
  it('defaults to "off" when unset', () => {
    const prev = process.env['ORACLE_AUTOFIX_MODE'];
    delete process.env['ORACLE_AUTOFIX_MODE'];
    try {
      assert.equal(readAutofixModeFromEnv(), 'off');
    } finally {
      if (prev !== undefined) process.env['ORACLE_AUTOFIX_MODE'] = prev;
    }
  });

  it('reads valid values', () => {
    const prev = process.env['ORACLE_AUTOFIX_MODE'];
    try {
      for (const m of ['off', 'propose', 'auto']) {
        process.env['ORACLE_AUTOFIX_MODE'] = m;
        assert.equal(readAutofixModeFromEnv(), m);
      }
    } finally {
      if (prev !== undefined) process.env['ORACLE_AUTOFIX_MODE'] = prev;
      else delete process.env['ORACLE_AUTOFIX_MODE'];
    }
  });

  it('falls back to "off" on unknown values', () => {
    const prev = process.env['ORACLE_AUTOFIX_MODE'];
    process.env['ORACLE_AUTOFIX_MODE'] = 'YOLO';
    try {
      assert.equal(readAutofixModeFromEnv(), 'off');
    } finally {
      if (prev !== undefined) process.env['ORACLE_AUTOFIX_MODE'] = prev;
      else delete process.env['ORACLE_AUTOFIX_MODE'];
    }
  });
});
