import { writeFileSync } from 'fs';
import { type AgentDecision } from './types.js';

const HELD_ARTIFACT_PATH = 'oracle-held-actions.json';

/**
 * Write held agent decisions to oracle-held-actions.json.
 *
 * Held actions are NOT re-processed automatically.  The artifact is intended
 * for operator review.  Re-ingestion (if desired) is a manual step outside
 * Slice 2 scope.
 */
export function writeHeldActions(decisions: AgentDecision[]): void {
  const payload = decisions.map(d => ({
    fingerprint:  d.fingerprint,
    proposalType: d.proposal.proposalType,
    sourceAgent:  d.proposal.sourceAgent,
    pipelineId:   d.proposal.pipelineId,
    testName:     d.proposal.testName,
    errorHash:    d.proposal.errorHash,
    confidence:   d.proposal.confidence,
    reasoning:    d.proposal.reasoning,
    reason:       d.reason,
  }));

  writeFileSync(HELD_ARTIFACT_PATH, JSON.stringify(payload, null, 2));
  console.log(`[oracle] ${decisions.length} held action(s) written to ${HELD_ARTIFACT_PATH}`);
}
