import { readFileSync } from 'fs';
import { type ZodIssue } from 'zod';
import { AgentProposalRawSchema, VALID_PROPOSAL_TYPES, type RawAgentProposal } from './schemas.js';
import { type AgentProposal } from './types.js';
import { oracleLog } from './logger.js';

// Re-export so existing consumers that import VALID_PROPOSAL_TYPES from this
// module do not need to change their import path.
export { VALID_PROPOSAL_TYPES };

/** Default ceiling on total proposals accepted per file load. */
const DEFAULT_MAX_PROPOSALS = 100;

/** Default ceiling on proposals accepted from any single source_agent per load. */
const DEFAULT_MAX_PER_SOURCE = 20;

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
 *
 * ## Rate limiting
 *
 * Two per-load ceilings prevent external agent sources from flooding the system:
 *
 *   ORACLE_MAX_PROPOSALS          — total accepted across all sources (default 100)
 *   ORACLE_MAX_PROPOSALS_PER_SOURCE — accepted per source_agent value (default 20)
 *
 * Proposals that would exceed either ceiling are dropped and logged; no error is
 * thrown. Limits are read from env at call time so tests can override without
 * module re-import.
 */
export function loadAgentProposals(filePath: string): AgentProposal[] {
  const maxTotal     = parseInt(process.env['ORACLE_MAX_PROPOSALS']            ?? '', 10) || DEFAULT_MAX_PROPOSALS;
  const maxPerSource = parseInt(process.env['ORACLE_MAX_PROPOSALS_PER_SOURCE'] ?? '', 10) || DEFAULT_MAX_PER_SOURCE;

  const text   = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(text) as unknown;
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

  const proposals: AgentProposal[] = [];
  const perSourceCount = new Map<string, number>();

  for (const item of items) {
    // ── Schema validation ───────────────────────────────────────────────────
    const result = AgentProposalRawSchema.safeParse(item);
    if (!result.success) {
      // Log field-level issues without echoing the full payload.
      const issues = result.error.issues
        .map((e: ZodIssue) =>
          `${e.path.length > 0 ? e.path.map(String).join('.') : '(root)'}: ${e.message}`,
        )
        .join('; ');
      oracleLog.warn('agent-proposal-loader', 'proposal.rejected', {
        reason: 'schema_validation',
        issues,
      });
      continue;
    }

    const proposal = toAgentProposal(result.data);

    // ── Global ceiling ──────────────────────────────────────────────────────
    if (proposals.length >= maxTotal) {
      oracleLog.warn('agent-proposal-loader', 'proposal.throttled', {
        reason:    'max_proposals_exceeded',
        limit:     maxTotal,
        source:    proposal.sourceAgent,
        test_name: proposal.testName,
      });
      continue;
    }

    // ── Per-source ceiling ──────────────────────────────────────────────────
    const sourceCount = perSourceCount.get(proposal.sourceAgent) ?? 0;
    if (sourceCount >= maxPerSource) {
      oracleLog.warn('agent-proposal-loader', 'proposal.throttled', {
        reason:    'max_per_source_exceeded',
        limit:     maxPerSource,
        source:    proposal.sourceAgent,
        test_name: proposal.testName,
      });
      continue;
    }

    perSourceCount.set(proposal.sourceAgent, sourceCount + 1);
    proposals.push(proposal);
  }
  return proposals;
}
