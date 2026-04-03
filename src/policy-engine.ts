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
 * Step 1 rules (only executable actions are emitted):
 *   - create_jira → REGRESSION or NEW_BUG with confidence > 0.7
 *
 * quarantine_test is intentionally omitted — no executor exists yet.
 * Fingerprints are keyed on testName + errorHash (not the DB row id) so they
 * remain stable across re-runs of the same pipeline.
 */
export function proposeFailureActions(
  result: TriageResult,
  failureId: number,
  runId: number,
  pipelineId: string,
): ActionProposal[] {
  const proposals: ActionProposal[] = [];
  const stableId = `${result.testName}:${result.errorHash}`;

  if (
    (result.category === TriageCategory.REGRESSION ||
      result.category === TriageCategory.NEW_BUG) &&
    result.confidence > 0.7
  ) {
    proposals.push({
      type:        'create_jira',
      scope:       'failure',
      scopeId:     stableId,
      failureId,
      clusterKey:  null,
      runId,
      pipelineId,
      source:      'policy',
      fingerprint: computeFingerprint('create_jira', 'failure', stableId),
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
 * Decide verdict for a proposed action.
 *
 * History context (Slice 1):
 *   - jiraAlreadyCreated: true → reject create_jira with audit reason
 *     'history:jira_already_created' so the decision is persisted and visible.
 *
 * All other policy proposals are auto-approved in Step 1.
 */
export function decide(
  proposal: ActionProposal,
  confidence: number,
  history: { jiraAlreadyCreated: boolean } = { jiraAlreadyCreated: false },
): Decision {
  if (proposal.type === 'create_jira' && history.jiraAlreadyCreated) {
    return {
      proposal,
      verdict:    'rejected',
      confidence,
      reason:     'history:jira_already_created',
    };
  }

  return {
    proposal,
    verdict:    'approved',
    confidence,
    reason:     'policy:auto-approved',
  };
}
