/**
 * Centralized schema definitions for all externally-sourced data.
 *
 * This file is the single source of truth for:
 *   - LLM triage output (TriageApiResponseSchema)
 *   - Incoming agent proposals (AgentProposalRawSchema)
 *
 * ## Valid triage categories
 * The LLM must classify every failure as exactly one of:
 *   FLAKY       — timing issue, race condition, or transient network error
 *   REGRESSION  — behaviour that previously worked is now broken
 *   ENV_ISSUE   — CI environment problem (certs, proxies, missing service)
 *   NEW_BUG     — endpoint or feature that was never implemented
 *
 * To add a category: add to TriageCategory enum in types.ts, then re-run
 * typecheck — this schema picks it up automatically via z.nativeEnum().
 *
 * ## Valid agent proposal types
 * The policy engine supports exactly these proposal types from external agents:
 *   retry_test           — request a test re-run
 *   request_human_review — flag for operator review
 *
 * To add a proposal type:
 *   1. Add the string to AGENT_PROPOSAL_TYPES below
 *   2. Add a handler in policy-engine.ts decideAgentProposal()
 *   3. Add an executor in index.ts if the action has a side effect
 */

import { z } from 'zod';
import { TriageCategory } from './types.js';

// ── Shared building blocks ────────────────────────────────────────────────────

/**
 * Confidence score: a finite number in the closed interval [0, 1].
 * NaN and ±Infinity are explicitly rejected via .finite().
 */
const ConfidenceSchema = z
  .number({ error: 'confidence must be a number' })
  .finite('confidence must be a finite number')
  .min(0, 'confidence must be >= 0')
  .max(1, 'confidence must be <= 1');

// ── LLM triage output ─────────────────────────────────────────────────────────

/**
 * Schema for a single item in the LLM triage response.
 *
 * All fields are required — the prompt explicitly asks the LLM to return all
 * of them on every result. If the LLM omits a field the batch is rejected so
 * the policy engine only ever receives structurally complete objects.
 */
export const TriageResultItemSchema = z.object({
  testName:      z.string().min(1, 'testName must be a non-empty string'),
  category:      z.nativeEnum(TriageCategory),
  confidence:    ConfidenceSchema,
  reasoning:     z.string(),
  suggested_fix: z.string(),
});

/** TypeScript type inferred directly from the schema. */
export type TriageResultItem = z.infer<typeof TriageResultItemSchema>;

/**
 * Schema for the full LLM triage response envelope.
 * The LLM returns `{ "results": [ ... ] }`.
 */
export const TriageApiResponseSchema = z.object({
  results: z.array(TriageResultItemSchema),
});

/** TypeScript type inferred directly from the schema. */
export type ZodTriageApiResponse = z.infer<typeof TriageApiResponseSchema>;

// ── Agent proposals ───────────────────────────────────────────────────────────

/**
 * Ordered list of proposal types the policy engine can handle.
 * The const-assertion enables z.enum() while keeping the type narrow.
 */
const AGENT_PROPOSAL_TYPES = ['retry_test', 'request_human_review'] as const;

/**
 * Set of valid agent proposal types — exported for O(1) lookups and
 * documentation. Derived from AGENT_PROPOSAL_TYPES so there is one place
 * to update when extending agent capabilities.
 */
export const VALID_PROPOSAL_TYPES = new Set<string>(AGENT_PROPOSAL_TYPES);

/**
 * Schema for raw agent proposals (snake_case JSON, as received from external
 * files). The loader maps these to the camelCase AgentProposal interface.
 *
 * Required fields:
 *   source_agent  — identifier of the proposing agent
 *   proposal_type — must be one of AGENT_PROPOSAL_TYPES
 *   pipeline_id   — pipeline run that owns this proposal
 *   test_name     — the failing test this proposal targets
 *   error_hash    — stable hash of the failure signature
 *   confidence    — agent's confidence in this proposal [0, 1]
 *
 * Optional fields:
 *   reasoning  — one-sentence explanation from the agent
 *   payload    — type-erased extra data for the executor
 */
export const AgentProposalRawSchema = z.object({
  source_agent:  z.string().min(1, 'source_agent must be a non-empty string'),
  proposal_type: z.enum(AGENT_PROPOSAL_TYPES, {
    error: `proposal_type must be one of: ${AGENT_PROPOSAL_TYPES.join(', ')}`,
  }),
  pipeline_id:   z.string().min(1, 'pipeline_id must be a non-empty string'),
  test_name:     z.string().min(1, 'test_name must be a non-empty string'),
  error_hash:    z.string().min(1, 'error_hash must be a non-empty string'),
  confidence:    ConfidenceSchema,
  reasoning:     z.string().optional(),
  payload:       z.record(z.string(), z.unknown()).optional(),
});

/** TypeScript type inferred directly from the schema (snake_case form). */
export type RawAgentProposal = z.infer<typeof AgentProposalRawSchema>;
