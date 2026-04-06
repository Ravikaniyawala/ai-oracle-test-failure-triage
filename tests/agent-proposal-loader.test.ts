import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadAgentProposals } from '../src/agent-proposal-loader.js';

const tmp = join(tmpdir(), 'oracle-agent-proposal-test');
mkdirSync(tmp, { recursive: true });
after(() => rmSync(tmp, { recursive: true, force: true }));

function write(name: string, content: unknown): string {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

const VALID_PROPOSAL = {
  source_agent:  'test-agent',
  proposal_type: 'retry_test',
  pipeline_id:   'run-001',
  test_name:     'MyTest > should pass',
  error_hash:    'abc123',
  confidence:    0.9,
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('loadAgentProposals — valid input', () => {
  it('loads a single proposal object', () => {
    const path = write('single.json', VALID_PROPOSAL);
    const proposals = loadAgentProposals(path);
    assert.equal(proposals.length, 1);
    const p = proposals[0]!;
    assert.equal(p.sourceAgent,  'test-agent');
    assert.equal(p.proposalType, 'retry_test');
    assert.equal(p.pipelineId,   'run-001');
    assert.equal(p.testName,     'MyTest > should pass');
    assert.equal(p.errorHash,    'abc123');
    assert.equal(p.confidence,   0.9);
  });

  it('loads an array of proposals', () => {
    const path = write('array.json', [
      VALID_PROPOSAL,
      { ...VALID_PROPOSAL, proposal_type: 'request_human_review', test_name: 'OtherTest > case' },
    ]);
    const proposals = loadAgentProposals(path);
    assert.equal(proposals.length, 2);
    assert.equal(proposals[0]!.proposalType, 'retry_test');
    assert.equal(proposals[1]!.proposalType, 'request_human_review');
  });

  it('defaults reasoning to empty string when absent', () => {
    const path = write('no-reasoning.json', VALID_PROPOSAL);
    const proposals = loadAgentProposals(path);
    assert.equal(proposals[0]!.reasoning, '');
  });

  it('uses provided reasoning when present', () => {
    const path = write('with-reasoning.json', { ...VALID_PROPOSAL, reasoning: 'flaky pattern' });
    const proposals = loadAgentProposals(path);
    assert.equal(proposals[0]!.reasoning, 'flaky pattern');
  });

  it('defaults payload to empty object when absent', () => {
    const path = write('no-payload.json', VALID_PROPOSAL);
    const proposals = loadAgentProposals(path);
    assert.deepEqual(proposals[0]!.payload, {});
  });

  it('uses provided payload when present', () => {
    const path = write('with-payload.json', { ...VALID_PROPOSAL, payload: { retryCount: 3 } });
    const proposals = loadAgentProposals(path);
    assert.deepEqual(proposals[0]!.payload, { retryCount: 3 });
  });

  it('passes through unknown proposal_type values without filtering', () => {
    const path = write('unknown-type.json', { ...VALID_PROPOSAL, proposal_type: 'some_future_action' });
    const proposals = loadAgentProposals(path);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.proposalType, 'some_future_action');
  });

  it('returns empty array for empty JSON array', () => {
    const path = write('empty-array.json', []);
    const proposals = loadAgentProposals(path);
    assert.equal(proposals.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Invalid / missing fields — skip bad entries, never throw
// ---------------------------------------------------------------------------

describe('loadAgentProposals — invalid entries', () => {
  it('skips entry missing source_agent', () => {
    const { source_agent: _, ...rest } = VALID_PROPOSAL;
    const path = write('no-source.json', rest);
    assert.equal(loadAgentProposals(path).length, 0);
  });

  it('skips entry missing proposal_type', () => {
    const { proposal_type: _, ...rest } = VALID_PROPOSAL;
    const path = write('no-type.json', rest);
    assert.equal(loadAgentProposals(path).length, 0);
  });

  it('skips entry missing pipeline_id', () => {
    const { pipeline_id: _, ...rest } = VALID_PROPOSAL;
    const path = write('no-pipeline.json', rest);
    assert.equal(loadAgentProposals(path).length, 0);
  });

  it('skips entry missing test_name', () => {
    const { test_name: _, ...rest } = VALID_PROPOSAL;
    const path = write('no-testname.json', rest);
    assert.equal(loadAgentProposals(path).length, 0);
  });

  it('skips entry missing error_hash', () => {
    const { error_hash: _, ...rest } = VALID_PROPOSAL;
    const path = write('no-hash.json', rest);
    assert.equal(loadAgentProposals(path).length, 0);
  });

  it('skips entry missing confidence', () => {
    const { confidence: _, ...rest } = VALID_PROPOSAL;
    const path = write('no-confidence.json', rest);
    assert.equal(loadAgentProposals(path).length, 0);
  });

  it('skips entry where confidence is a string', () => {
    const path = write('string-confidence.json', { ...VALID_PROPOSAL, confidence: '0.9' });
    assert.equal(loadAgentProposals(path).length, 0);
  });

  it('skips invalid entries but keeps valid ones in mixed array', () => {
    const path = write('mixed.json', [
      VALID_PROPOSAL,
      { source_agent: 'bad' },    // missing required fields
      null,
      { ...VALID_PROPOSAL, test_name: 'Second > test' },
    ]);
    const proposals = loadAgentProposals(path);
    assert.equal(proposals.length, 2);
    assert.equal(proposals[0]!.testName, 'MyTest > should pass');
    assert.equal(proposals[1]!.testName, 'Second > test');
  });
});
