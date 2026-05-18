/**
 * Queue artifact writer — emits `oracle-autofix-queue.json` listing
 * approved + held `fix_test_with_agent` candidates. Consumed downstream
 * by the test-healing agent (e.g. TestHealer) running in the
 * consumer's CI.
 *
 * Schema is intentionally a stable subset: future Phase 1 PRs (PR-status
 * tracking, dashboard surfaces) extend by adding fields; never breaking
 * what's here. `schemaVersion: 1` lets healers refuse a queue they
 * don't understand.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { ActionProposal, Decision, TriageResult } from './types.js';
import type { AutofixDecisionContext } from './autofix-policy.js';

export interface AutofixQueueEntry {
  fingerprint:         string;
  testName:            string;
  testFile:            string;
  errorHash:           string;
  category:            string;
  decision:            'approved' | 'held' | 'rejected';
  decisionReason:      string;
  effectiveMode:       'off' | 'propose' | 'auto';
  repoTopology:        string;
  topologyState:       string;

  // Detector evidence
  driftKind:           string | null;
  driftConfidence:     number;
  driftReasoning:      string;
  hasFailingLocator:   boolean;
  hardGuardsFired:     string[];

  // Trail
  runId:               number;
  pipelineId:          string;
  createdAt:           string;

  // Optional pointers to per-failure artifacts (Phase 0 reporter writes these)
  promptMdPath?:       string;
  ariaSnapshotPath?:   string;
  tracePath?:          string;
  screenshotPath?:     string;
}

export interface AutofixQueueArtifact {
  schemaVersion:       1;
  oracleRunId:         number;
  pipelineId:          string;
  generatedAt:         string;
  mode:                'off' | 'propose' | 'auto';
  totalEntries:        number;
  approvedCount:       number;
  heldCount:           number;
  rejectedCount:       number;
  /** Entries by decision. Rejected entries are kept for audit; healers
   *  consume `approved` only (and optionally `held` in propose mode). */
  queue:               AutofixQueueEntry[];
}

export interface QueueWriterInput {
  outputPath:    string;
  runId:         number;
  pipelineId:    string;
  mode:          'off' | 'propose' | 'auto';
  /** Per-failure proposal + decision + context bundle. */
  entries:       Array<{
    proposal: ActionProposal;
    decision: Decision;
    context:  AutofixDecisionContext;
    result:   TriageResult;
    artifactPaths?: {
      promptMd?:     string;
      ariaSnapshot?: string;
      trace?:        string;
      screenshot?:   string;
    };
  }>;
}

export function writeAutofixQueue(input: QueueWriterInput): AutofixQueueArtifact {
  const entries: AutofixQueueEntry[] = input.entries.map(e => {
    const drift = e.context.driftClassification;
    return {
      fingerprint:        e.proposal.fingerprint,
      testName:           e.result.testName,
      testFile:           e.result.file,
      errorHash:          e.result.errorHash,
      category:           e.result.category,
      decision:           e.decision.verdict === 'approved' ? 'approved'
                          : e.decision.verdict === 'held' ? 'held' : 'rejected',
      decisionReason:     e.decision.reason,
      effectiveMode:      e.context.effectiveMode,
      repoTopology:       e.context.topology,
      topologyState:      e.context.topologyState,
      driftKind:          drift?.kind ?? null,
      driftConfidence:    drift?.confidence ?? 0,
      driftReasoning:     drift?.reasoning ?? '',
      hasFailingLocator:  e.context.hasFailingLocator,
      hardGuardsFired:    e.context.hardGuards,
      runId:              e.proposal.runId,
      pipelineId:         e.proposal.pipelineId,
      createdAt:          new Date().toISOString(),
      ...(e.artifactPaths?.promptMd     ? { promptMdPath:     e.artifactPaths.promptMd }     : {}),
      ...(e.artifactPaths?.ariaSnapshot ? { ariaSnapshotPath: e.artifactPaths.ariaSnapshot } : {}),
      ...(e.artifactPaths?.trace        ? { tracePath:        e.artifactPaths.trace }        : {}),
      ...(e.artifactPaths?.screenshot   ? { screenshotPath:   e.artifactPaths.screenshot }   : {}),
    };
  });

  const approved = entries.filter(e => e.decision === 'approved').length;
  const held     = entries.filter(e => e.decision === 'held').length;
  const rejected = entries.filter(e => e.decision === 'rejected').length;

  const artifact: AutofixQueueArtifact = {
    schemaVersion: 1,
    oracleRunId:   input.runId,
    pipelineId:    input.pipelineId,
    generatedAt:   new Date().toISOString(),
    mode:          input.mode,
    totalEntries:  entries.length,
    approvedCount: approved,
    heldCount:     held,
    rejectedCount: rejected,
    queue:         entries,
  };

  mkdirSync(dirname(input.outputPath), { recursive: true });
  writeFileSync(input.outputPath, JSON.stringify(artifact, null, 2), 'utf8');
  return artifact;
}
