import { readFileSync } from 'fs';
import { type AgentProposal } from './types.js';

// Raw JSON shape (snake_case, as documented in the spec)
interface RawAgentProposal {
  source_agent:  string;
  proposal_type: string;
  pipeline_id:   string;
  test_name:     string;
  error_hash:    string;
  confidence:    number;
  reasoning?:    string;
  payload?:      Record<string, unknown>;
}

function isValid(raw: unknown): raw is RawAgentProposal {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r['source_agent']  === 'string' &&
    typeof r['proposal_type'] === 'string' &&
    typeof r['pipeline_id']   === 'string' &&
    typeof r['test_name']     === 'string' &&
    typeof r['error_hash']    === 'string' &&
    typeof r['confidence']    === 'number'
  );
}

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
 * validate each entry's required fields, and return valid proposals.
 *
 * Invalid entries are warned and skipped — they do not abort the batch.
 * Unknown proposal_type values pass through here; decisioning rejects them.
 */
export function loadAgentProposals(filePath: string): AgentProposal[] {
  const text  = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(text) as unknown;
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

  const proposals: AgentProposal[] = [];
  for (const item of items) {
    if (!isValid(item)) {
      console.warn('[oracle] agent proposal missing required fields, skipping:', JSON.stringify(item));
      continue;
    }
    proposals.push(toAgentProposal(item));
  }
  return proposals;
}
