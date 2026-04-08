import { readFileSync } from 'fs';
import { type ZodIssue } from 'zod';
import { AgentProposalRawSchema, VALID_PROPOSAL_TYPES, type RawAgentProposal } from './schemas.js';
import { type AgentProposal } from './types.js';

// Re-export so existing consumers that import VALID_PROPOSAL_TYPES from this
// module do not need to change their import path.
export { VALID_PROPOSAL_TYPES };

function toAgentProposal(raw: RawAgentProposal): AgentProposal {
  return {
    sourceAgent:  raw.source_agent,
    proposalType: raw.proposal_type,
    pipelineId:   raw.pipeline_id,
    testName:     raw.test_name,
    errorHash:    raw.error_hash,
    confidence:   raw.confidence,
    reasoning:    raw.reasoning ?? '',
    payload:      raw.payload   ?? {},
  };
}

/**
 * Read a JSON file containing one agent proposal object or an array of them,
 * validate each entry against AgentProposalRawSchema, and return valid proposals.
 *
 * Invalid entries are logged with field-level context and skipped — they do
 * not abort the batch (fail-partial, not fail-all).
 *
 * Entries with unknown proposal_type or out-of-range confidence are rejected
 * here, before reaching the policy engine (fail-closed contract).
 */
export function loadAgentProposals(filePath: string): AgentProposal[] {
  const text   = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(text) as unknown;
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

  const proposals: AgentProposal[] = [];
  for (const item of items) {
    const result = AgentProposalRawSchema.safeParse(item);
    if (!result.success) {
      // Log field-level issues without echoing the full payload.
      const issues = result.error.issues
        .map((e: ZodIssue) =>
          `${e.path.length > 0 ? e.path.map(String).join('.') : '(root)'}: ${e.message}`,
        )
        .join('; ');
      console.warn(`[oracle] agent proposal rejected (schema): ${issues}`);
      continue;
    }
    proposals.push(toAgentProposal(result.data));
  }
  return proposals;
}
