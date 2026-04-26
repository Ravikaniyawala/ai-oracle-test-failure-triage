import { createHash } from 'crypto';
import {
  TriageCategory,
  type ActionProposal,
  type ActionScope,
  type ActionType,
  type AgentDecision,
  type AgentProposal,
  type Decision,
  type FailureCluster,
  type PatternStats,
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
 *
 * NOTE: create_jira is no longer emitted here — it is now proposed at cluster
 * granularity via proposeClusterActions() so that failures sharing the same
 * root cause produce a single Jira ticket rather than one per failure.
 *
 * quarantine_test is intentionally omitted — no executor exists yet.
 */
export function proposeFailureActions(
  result: TriageResult,
  failureId: number,
  runId: number,
  pipelineId: string,
): ActionProposal[] {
  // Reserved for per-failure actions (retry_test, quarantine_test, etc.)
  // create_jira has moved to proposeClusterActions().
  void result; void failureId; void runId; void pipelineId;
  return [];
}

/**
 * Propose a create_jira action for each failure cluster.
 *
 * Rules:
 *   - Only clusters whose dominant category is REGRESSION or NEW_BUG with
 *     mean confidence > 0.7 generate a Jira proposal.
 *   - The fingerprint is derived from the stable clusterKey so the same root
 *     cause is deduplicated across pipeline runs.
 */
export function proposeClusterActions(
  cluster:    FailureCluster,
  runId:      number,
  pipelineId: string,
): ActionProposal[] {
  const proposals: ActionProposal[] = [];

  if (
    (cluster.category === TriageCategory.REGRESSION ||
      cluster.category === TriageCategory.NEW_BUG) &&
    cluster.confidence > 0.7
  ) {
    proposals.push({
      type:        'create_jira',
      scope:       'cluster',
      scopeId:     cluster.clusterKey,
      failureId:   null,
      clusterKey:  cluster.clusterKey,
      runId,
      pipelineId,
      source:      'policy',
      fingerprint: cluster.fingerprint,
      // Persist cluster membership so getPatternStats() can credit each
      // member with the cluster's jira_created / duplicate history on
      // later runs. Without this list, history-based suppression gradually
      // stops learning from clustered tickets.
      clusterMembers: cluster.failures.map(f => ({
        testName:  f.testName,
        errorHash: f.errorHash,
      })),
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
 * History rules for create_jira (applied in order, first match wins):
 *   1. jiraAlreadyCreated      → reject: 'history:jira_already_created'
 *   2. duplicate_pattern       → reject: 'history:duplicate_pattern'
 *      Rule: jiraDuplicateCount >= 2 AND jiraDuplicateCount >= jiraCreatedCount / 2
 *      Rationale: if at least half of all Jiras for this pattern were closed as
 *      duplicates, creating another is likely wasteful.
 *
 * All other policy proposals are auto-approved.
 */
export function decide(
  proposal: ActionProposal,
  confidence: number,
  history: {
    jiraAlreadyCreated:  boolean;
    jiraDuplicateCount?: number;
    jiraCreatedCount?:   number;
  } = { jiraAlreadyCreated: false },
): Decision {
  if (proposal.type === 'create_jira') {
    if (history.jiraAlreadyCreated) {
      return { proposal, verdict: 'rejected', confidence, reason: 'history:jira_already_created' };
    }

    const dupes   = history.jiraDuplicateCount ?? 0;
    const created = history.jiraCreatedCount   ?? 0;
    if (dupes >= 2 && dupes >= created / 2) {
      return { proposal, verdict: 'rejected', confidence, reason: 'history:duplicate_pattern' };
    }
  }

  return { proposal, verdict: 'approved', confidence, reason: 'policy:auto-approved' };
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
 *   - retry_test           → history rules first, then confidence-gated fallback
 *   - request_human_review → always approved (low-risk acknowledgement)
 *   - anything else        → rejected immediately
 *
 * retry_test history rules (applied before confidence thresholds, first match wins):
 *   - retryPassedCount >= 2 AND retryPassedCount > retryFailedCount
 *       → approve: 'history:retry_success_pattern'
 *   - retryFailedCount >= 2 AND retryFailedCount >= retryPassedCount
 *       → reject:  'history:retry_failure_pattern'
 *   - no history match → fall through to confidence thresholds
 *
 * @param stats Optional PatternStats for history-aware retry decisions.
 *              If omitted, only confidence thresholds apply.
 */
export function decideAgentProposal(proposal: AgentProposal, stats?: PatternStats): AgentDecision {
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
    // History rules take priority — they are based on real observed outcomes,
    // which is stronger evidence than the proposing agent's confidence score.
    if (stats !== undefined) {
      if (stats.retryPassedCount >= 2 && stats.retryPassedCount > stats.retryFailedCount) {
        return { proposal, verdict: 'approved', reason: 'history:retry_success_pattern', fingerprint };
      }
      if (stats.retryFailedCount >= 2 && stats.retryFailedCount >= stats.retryPassedCount) {
        return { proposal, verdict: 'rejected', reason: 'history:retry_failure_pattern', fingerprint };
      }
    }

    // No history match — fall back to confidence thresholds.
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
