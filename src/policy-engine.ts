import { createHash } from 'crypto';
import {
  TriageCategory,
  type ActionProposal,
  type ActionScope,
  type ActionType,
  type Decision,
  type TriageResult,
} from './types.js';

/**
 * Deterministic 16-char hex fingerprint for idempotent action deduplication.
 * sha256(type:scope:scopeId) → first 16 hex chars
 */
export function computeFingerprint(
  type: ActionType,
  scope: ActionScope,
  scopeId: string,
): string {
  return createHash('sha256')
    .update(`${type}:${scope}:${scopeId}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Propose actions for a single triaged failure.
 * Rules:
 *   - create_jira  → REGRESSION or NEW_BUG with confidence > 0.7
 *   - quarantine_test → FLAKY with retries >= 2
 */
export function proposeFailureActions(
  result: TriageResult,
  failureId: number,
  runId: number,
  pipelineId: string,
): ActionProposal[] {
  const proposals: ActionProposal[] = [];

  if (
    (result.category === TriageCategory.REGRESSION ||
      result.category === TriageCategory.NEW_BUG) &&
    result.confidence > 0.7
  ) {
    proposals.push({
      type:        'create_jira',
      scope:       'failure',
      scopeId:     String(failureId),
      failureId,
      clusterKey:  null,
      runId,
      pipelineId,
      source:      'policy',
      fingerprint: computeFingerprint('create_jira', 'failure', String(failureId)),
    });
  }

  if (result.category === TriageCategory.FLAKY && result.retries >= 2) {
    proposals.push({
      type:        'quarantine_test',
      scope:       'failure',
      scopeId:     String(failureId),
      failureId,
      clusterKey:  null,
      runId,
      pipelineId,
      source:      'policy',
      fingerprint: computeFingerprint('quarantine_test', 'failure', String(failureId)),
    });
  }

  return proposals;
}

/**
 * Propose run-level actions (one notify_slack per pipeline run).
 */
export function proposeRunActions(runId: number, pipelineId: string): ActionProposal[] {
  return [
    {
      type:        'notify_slack',
      scope:       'run',
      scopeId:     pipelineId,
      failureId:   null,
      clusterKey:  null,
      runId,
      pipelineId,
      source:      'policy',
      fingerprint: computeFingerprint('notify_slack', 'run', pipelineId),
    },
  ];
}

/**
 * Step 1: all policy-sourced proposals are auto-approved.
 */
export function decide(proposal: ActionProposal, confidence: number): Decision {
  return { proposal, verdict: 'approved', confidence };
}
