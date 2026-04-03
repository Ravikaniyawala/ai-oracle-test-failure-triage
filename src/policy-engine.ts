import { createHash } from 'crypto';
import {
  TriageCategory,
  type ActionProposal,
  type ActionScope,
  type ActionType,
  type AgentDecision,
  type AgentProposal,
  type Decision,
  type TriageResult,
} from './types.js';

/**
 * Deterministic 16-char hex fingerprint for idempotent action deduplication.
 * Accepts plain strings so it can be used for both policy and agent proposals.
 */
export function computeFingerprint(type: string, scope: string, scopeId: string): string {
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
 * Decide verdict for a policy-sourced action proposal.
 *
 * History context (Slice 1):
 *   - jiraAlreadyCreated: true → reject create_jira with audit reason
 *     'history:jira_already_created' so the decision is persisted and visible.
 *
 * All other policy proposals are auto-approved.
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

// ── Agent proposal decisions ──────────────────────────────────────────────────

// Confidence thresholds for retry_test:
//   >= 0.8 → approved  (high confidence — execute the retry)
//   >= 0.5 → held      (ambiguous — write to held artifact, needs operator review)
//   <  0.5 → rejected  (low confidence — not worth retrying)
const RETRY_APPROVE_THRESHOLD = 0.8;
const RETRY_HOLD_THRESHOLD    = 0.5;

/**
 * Decide verdict for an agent-sourced proposal.
 * Agents are untrusted proposers — they never bypass this layer.
 *
 * Supported proposal types:
 *   - retry_test          → confidence-gated: approved / held / rejected
 *   - request_human_review → always approved (low-risk acknowledgement)
 *   - anything else       → rejected immediately
 */
export function decideAgentProposal(proposal: AgentProposal): AgentDecision {
  const fingerprint = computeFingerprint(
    proposal.proposalType,
    'failure',
    `${proposal.testName}:${proposal.errorHash}`,
  );

  if (proposal.proposalType === 'request_human_review') {
    return {
      proposal,
      verdict:     'approved',
      reason:      'agent:request_human_review:low_risk',
      fingerprint,
    };
  }

  if (proposal.proposalType === 'retry_test') {
    if (proposal.confidence >= RETRY_APPROVE_THRESHOLD) {
      return { proposal, verdict: 'approved', reason: 'agent:retry_test:high_confidence', fingerprint };
    }
    if (proposal.confidence >= RETRY_HOLD_THRESHOLD) {
      return { proposal, verdict: 'held',     reason: 'agent:retry_test:ambiguous_confidence', fingerprint };
    }
    return { proposal, verdict: 'rejected', reason: 'agent:retry_test:low_confidence', fingerprint };
  }

  // Unknown proposal type — always reject, never execute.
  return { proposal, verdict: 'rejected', reason: 'agent:unsupported_proposal_type', fingerprint };
}

// Keep ActionType and ActionScope imports used by callers without re-exporting.
export type { ActionType, ActionScope };
