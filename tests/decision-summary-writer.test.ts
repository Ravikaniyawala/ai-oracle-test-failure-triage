/**
 * Tests for src/decision-summary-writer.ts
 *
 * Verifies the oracle-decision-summary.md artifact content — in particular
 * the Cross-cluster signals section wiring, which was missing from this
 * artifact in an earlier iteration even though signals appeared in the
 * GitHub step summary. These tests pin the contract down.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { writeDecisionSummary } from '../src/decision-summary-writer.js';
import { TriageCategory, type DecisionEntry, type TriageResult } from '../src/types.js';
import type { CrossClusterSignal } from '../src/cross-cluster-signals.js';

const tmp = join(tmpdir(), 'oracle-decision-summary-test');
mkdirSync(tmp, { recursive: true });
after(() => rmSync(tmp, { recursive: true, force: true }));

let fileCounter = 0;
function tmpPath(): string {
  fileCounter += 1;
  return join(tmp, `decision-${fileCounter}.md`);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function decision(overrides: Partial<DecisionEntry> = {}): DecisionEntry {
  return {
    actionType:  'create_jira',
    verdict:     'approved',
    reason:      'policy:auto-approved',
    explanation: 'create_jira approved — policy:auto-approved',
    testName:    'Suite > demo',
    ...overrides,
  };
}

function signal(overrides: Partial<CrossClusterSignal> = {}): CrossClusterSignal {
  return {
    type:         'test_persona',
    token:        'EarlieEddie',
    clusterKeys:  ['a', 'b'],
    clusterCount: 2,
    description:  '"EarlieEddie" appears in 2 clusters — possible shared test-account root cause',
    ...overrides,
  };
}

function result(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    testName:     'Suite > demo',
    errorMessage: 'Error: something',
    errorHash:    'abc123',
    file:         'tests/demo.spec.ts',
    duration:     100,
    retries:      0,
    category:     TriageCategory.REGRESSION,
    confidence:   0.9,
    reasoning:    '',
    suggestedFix: '',
    ...overrides,
  };
}

// ── Skip behaviour ────────────────────────────────────────────────────────────

describe('writeDecisionSummary — skip rules', () => {
  it('skips writing when decisionLog is empty AND no signals', () => {
    const path = tmpPath();
    const r = writeDecisionSummary([], 'pipe-0', 0, { outputPath: path });
    assert.equal(r.written, false, 'should NOT write an empty-everything artifact');
  });

  it('STILL writes when decisionLog is empty but cross-cluster signals exist', () => {
    const path = tmpPath();
    const r = writeDecisionSummary([], 'pipe-empty-signals', 2, {
      outputPath:   path,
      crossSignals: [signal()],
    });
    assert.equal(r.written, true, 'signals must surface even when no actions ran');
    const md = readFileSync(path, 'utf8');
    assert.ok(md.includes('Cross-cluster signals'));
    assert.ok(md.includes('EarlieEddie'));
  });
});

// ── Cross-cluster signals rendering ───────────────────────────────────────────

describe('writeDecisionSummary — cross-cluster signals', () => {
  it('renders the Cross-cluster signals section when signals are provided', () => {
    const path = tmpPath();
    writeDecisionSummary([decision()], 'pipe-sig-1', 1, {
      outputPath:   path,
      crossSignals: [signal({ token: 'EarlieEddie' })],
    });
    const md = readFileSync(path, 'utf8');

    assert.ok(md.includes('### Cross-cluster signals'), 'section header must appear');
    assert.ok(md.includes('EarlieEddie'),               'signal token must appear in the artifact');
    assert.ok(md.includes('advisory'),                  'should carry the advisory-only caveat');
  });

  it('does NOT render the section when no signals are detected', () => {
    const path = tmpPath();
    writeDecisionSummary([decision()], 'pipe-sig-2', 1, { outputPath: path });
    const md = readFileSync(path, 'utf8');
    assert.ok(!md.includes('Cross-cluster signals'), 'no section when signals are empty/undefined');
  });

  it('places Cross-cluster signals AFTER History-influenced and BEFORE PR / Change Context', () => {
    const path = tmpPath();
    writeDecisionSummary(
      [decision({ reason: 'history:duplicate_pattern', verdict: 'rejected' })],
      'pipe-sig-order',
      1,
      {
        outputPath:   path,
        crossSignals: [signal()],
        prContext: {
          pipelineId:   'pipe-sig-order',
          prNumber:     42,
          title:        'demo pr',
          author:       'someone',
          filesChanged: ['src/foo.ts'],
          linkedJira:   [],
        },
        relevanceMap: new Map(),
        results:      [result()],
      },
    );
    const md = readFileSync(path, 'utf8');
    const idxHistory = md.indexOf('History-influenced');
    const idxSignals = md.indexOf('Cross-cluster signals');
    const idxPr      = md.indexOf('PR / Change Context');

    assert.ok(idxHistory >= 0 && idxSignals >= 0 && idxPr >= 0, 'all three sections should render');
    assert.ok(idxHistory < idxSignals, `History-influenced should precede signals (got ${idxHistory} vs ${idxSignals})`);
    assert.ok(idxSignals < idxPr,      `Cross-cluster signals should precede PR context (got ${idxSignals} vs ${idxPr})`);
  });
});
