import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeAutofixQueue, type AutofixQueueArtifact } from '../src/autofix-queue-writer.js';
import { TriageCategory, type ActionProposal, type Decision, type TriageResult } from '../src/types.js';
import type { AutofixDecisionContext } from '../src/autofix-policy.js';

const tmp = mkdtempSync(join(tmpdir(), 'autofix-queue-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function makeProposal(): ActionProposal {
  return {
    type:        'fix_test_with_agent',
    scope:       'failure',
    scopeId:     'Suite > test:abc',
    failureId:   1,
    clusterKey:  null,
    runId:       42,
    pipelineId:  'pipe-X',
    source:      'policy',
    fingerprint: 'fp-1',
  };
}

function makeResult(): TriageResult {
  return {
    testName:     'Suite > test',
    errorMessage: 'TimeoutError',
    errorHash:    'abc',
    file:         'tests/foo.spec.ts',
    duration:     100,
    retries:      0,
    category:     TriageCategory.FLAKY,
    confidence:   0.85,
    reasoning:    'r',
    suggestedFix: 'f',
  };
}

function makeContext(): AutofixDecisionContext {
  return {
    driftClassification: {
      kind: 'locator_drift_data_testid_only',
      confidence: 0.90,
      reasoning: 'test attr drifted',
    },
    hardGuards:        [],
    effectiveMode:     'auto',
    topology:          'monorepo_e2e',
    topologyState:     'full',
    hasFailingLocator: true,
  };
}

describe('writeAutofixQueue', () => {
  it('emits a valid v1 schema artifact', () => {
    const outPath = join(tmp, 'q1.json');
    const decision: Decision = { proposal: makeProposal(), verdict: 'approved', confidence: 0.9, reason: 'policy:auto-approved' };
    const artifact = writeAutofixQueue({
      outputPath: outPath,
      runId:      42,
      pipelineId: 'pipe-X',
      mode:       'auto',
      entries:    [{
        proposal: makeProposal(),
        decision,
        context:  makeContext(),
        result:   makeResult(),
      }],
    });
    assert.equal(artifact.schemaVersion, 1);
    assert.equal(artifact.oracleRunId, 42);
    assert.equal(artifact.mode, 'auto');
    assert.equal(artifact.totalEntries, 1);
    assert.equal(artifact.approvedCount, 1);
    assert.equal(artifact.heldCount, 0);
    assert.equal(artifact.rejectedCount, 0);

    const onDisk = JSON.parse(readFileSync(outPath, 'utf8')) as AutofixQueueArtifact;
    assert.equal(onDisk.schemaVersion, 1);
    assert.equal(onDisk.queue[0]!.fingerprint, 'fp-1');
    assert.equal(onDisk.queue[0]!.decision, 'approved');
    assert.equal(onDisk.queue[0]!.driftKind, 'locator_drift_data_testid_only');
  });

  it('counts approved/held/rejected separately', () => {
    const outPath = join(tmp, 'q2.json');
    const artifact = writeAutofixQueue({
      outputPath: outPath,
      runId: 1, pipelineId: 'p', mode: 'propose',
      entries: [
        { proposal: { ...makeProposal(), fingerprint: 'a' }, decision: { proposal: makeProposal(), verdict: 'approved', confidence: 0.9, reason: '' }, context: makeContext(), result: makeResult() },
        { proposal: { ...makeProposal(), fingerprint: 'b' }, decision: { proposal: makeProposal(), verdict: 'held', confidence: 0, reason: 'mode_propose' }, context: makeContext(), result: makeResult() },
        { proposal: { ...makeProposal(), fingerprint: 'c' }, decision: { proposal: makeProposal(), verdict: 'held', confidence: 0, reason: 'mode_propose' }, context: makeContext(), result: makeResult() },
        { proposal: { ...makeProposal(), fingerprint: 'd' }, decision: { proposal: makeProposal(), verdict: 'rejected', confidence: 0, reason: 'hard_negative_value_mismatch' }, context: makeContext(), result: makeResult() },
      ],
    });
    assert.equal(artifact.totalEntries, 4);
    assert.equal(artifact.approvedCount, 1);
    assert.equal(artifact.heldCount, 2);
    assert.equal(artifact.rejectedCount, 1);
  });

  it('preserves artifactPaths when provided', () => {
    const outPath = join(tmp, 'q3.json');
    writeAutofixQueue({
      outputPath: outPath,
      runId: 1, pipelineId: 'p', mode: 'auto',
      entries: [{
        proposal: makeProposal(),
        decision: { proposal: makeProposal(), verdict: 'approved', confidence: 0.9, reason: '' },
        context:  makeContext(),
        result:   makeResult(),
        artifactPaths: {
          promptMd:     'test-results/failure-context/x/prompt.md',
          ariaSnapshot: 'test-results/failure-context/x/aria.txt',
        },
      }],
    });
    const onDisk = JSON.parse(readFileSync(outPath, 'utf8')) as AutofixQueueArtifact;
    assert.equal(onDisk.queue[0]!.promptMdPath, 'test-results/failure-context/x/prompt.md');
    assert.equal(onDisk.queue[0]!.ariaSnapshotPath, 'test-results/failure-context/x/aria.txt');
    assert.equal(onDisk.queue[0]!.tracePath, undefined);
  });
});
