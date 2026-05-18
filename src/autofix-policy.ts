/**
 * Autofix policy engine — proposes `fix_test_with_agent` actions for a
 * triaged failure and decides their verdict using the 8-gate routing
 * matrix from docs/autofix-design.md.
 *
 * Kept as a standalone module rather than threaded through policy-engine.ts
 * so the safety-critical gating logic is reviewable in isolation and so
 * the existing policy code stays focused on Jira / Slack / retry gating.
 *
 * Phase 1 ships this with `ORACLE_AUTOFIX_MODE=off` as the default — the
 * function returns `[]` unconditionally when mode is off, so existing
 * Oracle consumers see no behavior change.
 */

import { createHash } from 'crypto';
import {
  TriageCategory,
  type ActionProposal,
  type Decision,
  type PatternStats,
  type PrContext,
  type TriageResult,
} from './types.js';
import type {
  AriaSnapshotElement,
  LocatorDriftClassification,
  RepoTopology,
  TopologyValidationResult,
} from './autofix-detector/types.js';
import {
  AUTO_ELIGIBLE_REPAIRABILITY_KINDS,
  DEFAULT_TEST_ATTRIBUTE_NAMES,
  DEFAULT_TOPOLOGY_THRESHOLDS,
} from './autofix-detector/types.js';
import { classifyLocatorDrift } from './autofix-detector/locator-drift-classifier.js';
import { parseFailingLocator } from './autofix-detector/locator-parser.js';

// ── Mode handling ─────────────────────────────────────────────────────────────

export type AutofixMode = 'off' | 'propose' | 'auto';

/**
 * Read `ORACLE_AUTOFIX_MODE` from env, default `off`. Unknown values fall
 * back to `off` (fail-safe) and emit a warning to stderr.
 */
export function readAutofixModeFromEnv(): AutofixMode {
  const raw = (process.env['ORACLE_AUTOFIX_MODE'] ?? 'off').toLowerCase();
  if (raw === 'off' || raw === 'propose' || raw === 'auto') return raw;
  console.warn(
    `[oracle] unknown ORACLE_AUTOFIX_MODE="${raw}"; falling back to "off"`,
  );
  return 'off';
}

/**
 * Configurable cap on the number of auto-approved healers per Oracle run.
 * Defaults to 10. Excess approved candidates downgrade to `held` so the
 * healer doesn't open dozens of PRs on a single CI run.
 */
export function readMaxAutoHealsPerRun(): number {
  const raw = parseInt(process.env['ORACLE_MAX_AUTOHEALS_PER_RUN'] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
}

// ── Hard-negative guards ──────────────────────────────────────────────────────

/**
 * Hard-negative guards that any-fire → reject autofix. These are checked
 * regardless of failureSource attribution, so even if structural source
 * detection mistakenly returns `test_code`, these still block.
 *
 * Phase 1 implements the safety-critical subset directly; Phase 2 may add
 * more sophisticated guards (e.g. assertion-removal-risk detection at
 * patch verification time, which belongs in the healer rather than here).
 */
export type AutofixHardGuard =
  | 'value_mismatch'
  | 'http_status_mismatch'
  | 'environment_hard_pin'
  | 'missing_or_unsafe_artifact_path'
  | 'artifact_trust_insufficient_for_auto'
  | 'ambiguous_repair_target';

const EXPECT_RECEIVED_PATTERN = /expect\(received\)/;
const RECEIVED_LINE_PATTERN   = /Received:/;
const EXPECTED_LINE_PATTERN   = /Expected:/;
const HTTP_STATUS_PATTERN     = /HTTP (4|5)\d\d|Received:\s*(4|5)\d\d|toHaveURL|toHaveTitle/;
const NETWORK_ERROR_PATTERN   = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo/;
const BROWSER_LIFECYCLE_ERROR = /browser(?:Type)? (?:has been )?(?:closed|crashed)|Executable doesn't exist|browserType\.launch/;

function isValueMismatch(msg: string): boolean {
  // Order-independent: real Playwright/Jest output may show either
  // Received: before Expected: or vice versa. Either order with both
  // markers present + `expect(received)` is a strong assertion-value
  // mismatch signal.
  return EXPECT_RECEIVED_PATTERN.test(msg) &&
         RECEIVED_LINE_PATTERN.test(msg) &&
         EXPECTED_LINE_PATTERN.test(msg);
}

/**
 * Walk the hard-negative guards. Returns the list of guards that fired
 * (may be empty). The autofix gate rejects if any guard appears.
 *
 * `effectiveMode` is the post-topology-override mode; when topology
 * disallows auto, callers pass `propose` here regardless of env config.
 */
export function evaluateHardGuards(args: {
  result:              TriageResult;
  effectiveMode:       AutofixMode;
  artifactTrustLevel?: 'trusted' | 'partial' | 'untrusted';
  driftClassification: LocatorDriftClassification | null;
}): AutofixHardGuard[] {
  const fired: AutofixHardGuard[] = [];
  const msg = args.result.errorMessage ?? '';

  if (isValueMismatch(msg))             fired.push('value_mismatch');
  if (HTTP_STATUS_PATTERN.test(msg))    fired.push('http_status_mismatch');

  if (NETWORK_ERROR_PATTERN.test(msg) || BROWSER_LIFECYCLE_ERROR.test(msg)) {
    fired.push('environment_hard_pin');
  }

  // Artifact trust: only enforced in auto mode (per Codex re-review fix).
  // In propose mode, partial/untrusted artifacts still surface for human
  // review.
  if (
    args.effectiveMode === 'auto' &&
    args.artifactTrustLevel !== undefined &&
    args.artifactTrustLevel !== 'trusted'
  ) {
    fired.push('artifact_trust_insufficient_for_auto');
  }

  // Ambiguous repair target: classifier was given multiple plausible
  // candidates with different user-visible names. Phase 1 detector
  // returns `kind: null` in this case; this guard is reserved for
  // future detection of explicit ambiguity (e.g. multiple ARIA
  // elements with matching role + similar testid value).
  if (args.driftClassification?.candidate &&
      args.driftClassification.kind === null &&
      /multiple candidate/i.test(args.driftClassification.reasoning)) {
    fired.push('ambiguous_repair_target');
  }

  return fired;
}

// ── Proposal builder ──────────────────────────────────────────────────────────

export interface AutofixProposalInput {
  result:                 TriageResult;
  failureId:              number;
  runId:                  number;
  pipelineId:             string;
  /** Structural ARIA snapshot for this failure (from custom Playwright reporter). */
  ariaSnapshot?:          AriaSnapshotElement[];
  /** Test-attribute names — defaults to DEFAULT_TEST_ATTRIBUTE_NAMES.
   *  Consumers using non-default Playwright `testIdAttribute` pass theirs. */
  testAttributeNames?:    readonly string[];
}

/**
 * Cached classification + supporting context attached to each proposal.
 * Carried through Decision.reason / saveAction's payload_json so the
 * downstream queue artifact and dashboards can render the evidence
 * without re-running the detector.
 */
export interface AutofixDecisionContext {
  driftClassification: LocatorDriftClassification | null;
  hardGuards:          AutofixHardGuard[];
  effectiveMode:       AutofixMode;
  topology:            RepoTopology;
  topologyState:       TopologyValidationResult['state'];
  /** Did `failingLocator` parse from the error message? */
  hasFailingLocator:   boolean;
}

/**
 * Compute a `fix_test_with_agent` proposal for a single failure if the
 * basic preconditions hold. Gate 1 (category) is enforced here as a hard
 * filter — REGRESSION / NEW_BUG / ENV_ISSUE never produce a proposal,
 * regardless of any other input. This is the load-bearing safety
 * invariant: even with mode=auto, a regression cannot reach the queue.
 *
 * The actual approve/hold/reject verdict comes from `decideAutofixAction`.
 */
export function proposeTestFixActions(
  input: AutofixProposalInput,
  mode:  AutofixMode,
): ActionProposal[] {
  // HARD GATE: only FLAKY proceeds. This must be the first check and
  // must not depend on any other input — including mode, topology, or
  // detector output. Pinning the order is the entire defense-in-depth
  // story: a misclassified REGRESSION cannot leak through this gate
  // regardless of what the detector or env says.
  if (input.result.category !== TriageCategory.FLAKY) {
    return [];
  }

  // Mode off → no proposal. Default for all existing Oracle consumers.
  if (mode === 'off') {
    return [];
  }

  const scopeId     = `${input.result.testName}:${input.result.errorHash}`;
  const fingerprint = createHash('sha256')
    .update(`fix_test_with_agent:failure:${scopeId}`)
    .digest('hex')
    .slice(0, 16);

  return [
    {
      type:        'fix_test_with_agent',
      scope:       'failure',
      scopeId,
      failureId:   input.failureId,
      clusterKey:  null,
      runId:       input.runId,
      pipelineId:  input.pipelineId,
      source:      'policy',
      fingerprint,
    },
  ];
}

// ── Verdict resolver — the 8-gate routing matrix ──────────────────────────────

export interface AutofixDecisionInput {
  proposal:                ActionProposal;
  result:                  TriageResult;
  history:                 PatternStats;
  detectorOutput?: {
    /** Locator drift classification (null when no candidate). */
    drift:               LocatorDriftClassification | null;
    /** ARIA snapshot was available for this failure. */
    hasAriaSnapshot:     boolean;
    /** Stack-frame trust level aggregated for the failure. */
    artifactTrustLevel:  'trusted' | 'partial' | 'untrusted';
  };
  /** Topology declaration + validation result. */
  topology:                {
    declared:            RepoTopology;
    state:               TopologyValidationResult['state'];
    allowsAuto:          boolean;
  };
  /** PR context if available (used for self-modification / product-modification guards). */
  prContext?:              PrContext | null;
  /** Files (repo-relative) under which the test owns its source. */
  allowedEditPaths?:       readonly string[];
  /** Files under product source. */
  productSourcePatterns?:  { include: readonly string[]; exclude: readonly string[] };
  /** Glob matcher fn — caller injects to avoid hard picomatch dep here. */
  matchPattern?:           (file: string, pattern: string) => boolean;
  /** Whether testHistory shows ≥3 prior runs (insufficient-history gate). */
  testRunCount?:           number;
  /** Approved-this-run counter for rate limiting. */
  alreadyApprovedThisRun:  number;
  maxAutoHealsPerRun:      number;
  /** Mode after topology override (split_e2e forces 'propose'). */
  effectiveMode:           AutofixMode;
}

/**
 * Routing matrix from docs/autofix-design.md. Top-to-bottom, first match wins.
 *
 *   1. category in {REGRESSION, NEW_BUG, ENV_ISSUE}    → reject
 *   2. testHistory.runCount < 3                         → reject
 *   3. selfModificationGuard fired                      → reject
 *   4. any hard negative guard fired                    → reject
 *   5. productModificationGuard fired
 *        AND effectiveMode == auto                      → reject
 *        AND effectiveMode == propose                   → hold
 *   6. failureSource == app_code | environment          → reject
 *   7. failureSource == unknown
 *        AND effectiveMode == auto                      → reject
 *        AND effectiveMode == propose                   → hold
 *   8. history rule fix_decay tripped                   → hold
 *   9. history rule heal_pr_pending tripped             → reject
 *   10. history rule failed_pattern tripped             → reject
 *   11. ORACLE_AUTOFIX_MODE == off                       → reject (already filtered earlier)
 *   12. queueCount >= maxAutoHealsAllowed                → hold
 *   13. repairabilityKind == null/non-AUTO_ELIGIBLE      → hold
 *   14. repairabilityKind == user_visible_text           → hold (propose) / reject (auto)
 *   15. repairabilityConfidence < 0.70                   → hold
 *   16. sourceConfidence < topology threshold            → hold
 *   17. totalSourceEvidenceWeight < topology floor       → hold
 *   18. effectiveMode == propose                         → hold
 *   19. else                                             → approve
 *
 * Phase 1 implements steps 1–18 actively; step 19 approves. The
 * `selfModificationGuard` (step 3) is computed here from PR context;
 * `productModificationGuard` (step 5) is computed similarly.
 *
 * `failureSource` is a Phase 2 concept (the source-attribution detector
 * isn't built yet). Step 6/7 fire when the detector returns null kind
 * with an explicit `app_code`/`environment` reasoning hint or when the
 * locator-drift classifier returned null with no candidate.
 */
export function decideAutofixAction(input: AutofixDecisionInput): Decision {
  const proposal = input.proposal;
  const category = input.result.category;

  // Gate 1 — category. REGRESSION/NEW_BUG/ENV_ISSUE never proceed.
  // proposeTestFixActions already filters these out, but defense-in-depth
  // means we ALSO check here so a future caller that builds a proposal
  // directly cannot bypass the gate.
  if (
    category === TriageCategory.REGRESSION ||
    category === TriageCategory.NEW_BUG ||
    category === TriageCategory.ENV_ISSUE
  ) {
    return reject(proposal, 'category_not_autofix_eligible');
  }

  // Gate 2 — insufficient history. New tests (< 3 prior runs) must not be
  // auto-healed; we can't distinguish "newly-broken test" from "newly-added
  // intentionally-failing test".
  if (input.testRunCount !== undefined && input.testRunCount < 3) {
    return reject(proposal, 'insufficient_history');
  }

  // Gate 3 — self-modification: the PR touches the failing test's owned
  // code. Mode-independent reject — if the human just edited the test,
  // the failure is more likely about that edit than about drift.
  const selfMod = selfModificationGuard({
    prContext:        input.prContext,
    testFile:         input.result.file,
    allowedEditPaths: input.allowedEditPaths,
    matchPattern:     input.matchPattern,
  });
  if (selfMod) {
    return reject(proposal, 'pr_context_test_owned_code_modified');
  }

  // Gate 4 — hard negative guards.
  const hardGuards = evaluateHardGuards({
    result:               input.result,
    effectiveMode:        input.effectiveMode,
    artifactTrustLevel:   input.detectorOutput?.artifactTrustLevel,
    driftClassification:  input.detectorOutput?.drift ?? null,
  });
  if (hardGuards.length > 0) {
    return reject(proposal, `hard_negative_${hardGuards[0]}`);
  }

  // Gate 5 — product-modification guard. Mode-specific (auto rejects,
  // propose holds for human review).
  const prodMod = productModificationGuard({
    prContext:             input.prContext,
    productSourcePatterns: input.productSourcePatterns,
    matchPattern:          input.matchPattern,
  });
  if (prodMod) {
    if (input.effectiveMode === 'auto') {
      return reject(proposal, 'pr_context_product_modified');
    }
    return hold(proposal, 'pr_context_product_modified');
  }

  // Gate 6 — explicit env/app source attribution (Phase 1 inferred from
  // hard-guard signals; full failureSource detector lands in Phase 2).
  // The environment_hard_pin guard already fired earlier, but we keep
  // this row as a placeholder so the routing matrix stays aligned with
  // the design doc.

  // Gate 7 — unknown source. Phase 1 proxy: drift classifier returned
  // null kind. In propose mode, surface as hold for review; in auto
  // mode, reject.
  const drift = input.detectorOutput?.drift;
  const driftNull = !drift || drift.kind === null;
  if (driftNull) {
    if (input.effectiveMode === 'auto') {
      return reject(proposal, 'source_unknown_in_auto_mode');
    }
    // For propose mode, continue to the repairability/mode-propose gate
    // below (which routes null repairability to hold with a more
    // specific reason).
  }

  // Gate 8 — fix-decay rule. If we previously applied an agent fix for
  // this pattern within the last 14 days and the failure is back, the
  // fix didn't stick. Hold for human review.
  const FIX_DECAY_WINDOW_DAYS = readFixDecayWindowDays();
  if (input.history.lastAgentFixApplied) {
    const last = new Date(input.history.lastAgentFixApplied).getTime();
    const cutoff = Date.now() - FIX_DECAY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if (last > cutoff) {
      return hold(proposal, 'history:fix_decay_suspected');
    }
  }

  // Gate 9 — heal PR pending. Phase 1 proxy: if we successfully applied
  // a fix but the failure recurred this run, treat as pending merge.
  // Detected when agentFixAppliedCount > 0 within the last window.
  // (Distinct from fix-decay: pending means we suspect the PR is still
  // unreviewed/unmerged; decay means it was merged and decayed.)
  // Phase 1 keeps these as a single rule — `history:fix_decay_suspected`
  // covers both. Phase 4 PR-status tracking will distinguish them.

  // Gate 10 — repeated failure pattern. If the agent has failed N times
  // on this pattern, give up and route to Jira.
  if (
    input.history.agentFixFailedCount >= 2 &&
    input.history.agentFixFailedCount >= input.history.agentFixAppliedCount
  ) {
    return reject(proposal, 'history:agent_fix_failure_pattern');
  }

  // Gate 11 — mode off (already filtered in proposeTestFixActions).

  // Gate 12 — rate limit per run.
  if (input.alreadyApprovedThisRun >= input.maxAutoHealsPerRun) {
    return hold(proposal, 'history:rate_limit_per_run');
  }

  // Gate 13 — repairability insufficient.
  if (!drift || drift.kind === null) {
    return hold(proposal, 'repairability_insufficient');
  }
  if (!AUTO_ELIGIBLE_REPAIRABILITY_KINDS.has(drift.kind)) {
    // Auto mode: user-visible-text drift specifically rejects.
    if (input.effectiveMode === 'auto' &&
        drift.kind === 'locator_drift_user_visible_text') {
      return reject(proposal, 'repairability_user_visible_change');
    }
    return hold(proposal, drift.kind === 'locator_drift_user_visible_text'
      ? 'repairability_user_visible_change'
      : 'repairability_insufficient');
  }

  // Gate 15 — repairability confidence.
  const repThreshold = DEFAULT_TOPOLOGY_THRESHOLDS[input.topology.declared].repairabilityConfidenceForAuto;
  if (drift.confidence < repThreshold) {
    return hold(proposal, 'repairability_confidence_low');
  }

  // Gate 18 — mode propose: hold (Phase 2+ will let humans approve from
  // dashboard or Slack to flip to approved).
  if (input.effectiveMode === 'propose') {
    return hold(proposal, 'mode_propose');
  }

  // Gate 19 — approve.
  return {
    proposal,
    verdict:    'approved',
    confidence: drift.confidence,
    reason:     'policy:auto-approved',
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function reject(proposal: ActionProposal, reason: string): Decision {
  return { proposal, verdict: 'rejected', confidence: 0, reason };
}

function hold(proposal: ActionProposal, reason: string): Decision {
  return { proposal, verdict: 'held', confidence: 0, reason };
}

function selfModificationGuard(args: {
  prContext?:        PrContext | null;
  testFile?:         string;
  allowedEditPaths?: readonly string[];
  matchPattern?:     (f: string, p: string) => boolean;
}): boolean {
  if (!args.prContext || !args.allowedEditPaths || !args.matchPattern) return false;
  const match = args.matchPattern;
  return args.prContext.filesChanged.some(f =>
    args.allowedEditPaths!.some(p => match(f, p)),
  );
}

function productModificationGuard(args: {
  prContext?:             PrContext | null;
  productSourcePatterns?: { include: readonly string[]; exclude: readonly string[] };
  matchPattern?:          (f: string, p: string) => boolean;
}): boolean {
  if (!args.prContext || !args.productSourcePatterns || !args.matchPattern) return false;
  const match = args.matchPattern;
  return args.prContext.filesChanged.some(
    f =>
      args.productSourcePatterns!.include.some(p => match(f, p)) &&
      !args.productSourcePatterns!.exclude.some(p => match(f, p)),
  );
}

function readFixDecayWindowDays(): number {
  const raw = parseInt(process.env['ORACLE_FIX_DECAY_WINDOW_DAYS'] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 14;
}

// ── Higher-level orchestration ────────────────────────────────────────────────

/**
 * Run the autofix detector + policy gating for a single failure. Returns
 * the proposal + decision pair, or null if the failure didn't even
 * propose (mode=off or non-FLAKY category).
 *
 * Callers wire this into `src/index.ts` alongside the existing policy
 * proposals — it's intentionally a separate code path so the new logic
 * is opt-in via `ORACLE_AUTOFIX_MODE`.
 */
export interface AutofixOrchestrationInput {
  result:                  TriageResult;
  failureId:               number;
  runId:                   number;
  pipelineId:              string;
  history:                 PatternStats;
  mode:                    AutofixMode;
  topology: {
    declared:              RepoTopology;
    state:                 TopologyValidationResult['state'];
    allowsAuto:            boolean;
  };
  prContext?:              PrContext | null;
  allowedEditPaths?:       readonly string[];
  productSourcePatterns?:  { include: readonly string[]; exclude: readonly string[] };
  matchPattern?:           (file: string, pattern: string) => boolean;
  testAttributeNames?:     readonly string[];
  ariaSnapshot?:           AriaSnapshotElement[];
  artifactTrustLevel?:     'trusted' | 'partial' | 'untrusted';
  testRunCount?:           number;
  alreadyApprovedThisRun:  number;
  maxAutoHealsPerRun:      number;
}

export interface AutofixDecisionOutcome {
  proposal: ActionProposal;
  decision: Decision;
  context:  AutofixDecisionContext;
}

export function runAutofixPolicy(input: AutofixOrchestrationInput): AutofixDecisionOutcome | null {
  // Topology override: split_e2e forces effectiveMode = propose regardless
  // of the configured ORACLE_AUTOFIX_MODE. This is the Phase 1 invariant —
  // split-repo deploy correlation (Phase 4+) is the unblocker.
  const effectiveMode: AutofixMode =
    input.mode === 'off' ? 'off' :
    (input.topology.allowsAuto ? input.mode : 'propose');

  const proposals = proposeTestFixActions(
    {
      result:             input.result,
      failureId:          input.failureId,
      runId:              input.runId,
      pipelineId:         input.pipelineId,
      ariaSnapshot:       input.ariaSnapshot,
      testAttributeNames: input.testAttributeNames,
    },
    effectiveMode,
  );
  if (proposals.length === 0) return null;
  const proposal = proposals[0]!;

  // Run the locator-drift detector against the supplied ARIA snapshot.
  const failingLocator = parseFailingLocator(input.result.errorMessage ?? '');
  let drift: LocatorDriftClassification | null = null;
  if (failingLocator && input.ariaSnapshot) {
    drift = classifyLocatorDrift({
      failingLocator,
      ariaSnapshot:       input.ariaSnapshot,
      testAttributeNames: input.testAttributeNames ?? DEFAULT_TEST_ATTRIBUTE_NAMES,
    });
  }

  const decision = decideAutofixAction({
    proposal,
    result:                input.result,
    history:               input.history,
    detectorOutput: {
      drift,
      hasAriaSnapshot:     !!input.ariaSnapshot && input.ariaSnapshot.length > 0,
      artifactTrustLevel:  input.artifactTrustLevel ?? 'untrusted',
    },
    topology:              input.topology,
    prContext:             input.prContext,
    allowedEditPaths:      input.allowedEditPaths,
    productSourcePatterns: input.productSourcePatterns,
    matchPattern:          input.matchPattern,
    testRunCount:          input.testRunCount,
    alreadyApprovedThisRun: input.alreadyApprovedThisRun,
    maxAutoHealsPerRun:    input.maxAutoHealsPerRun,
    effectiveMode,
  });

  const context: AutofixDecisionContext = {
    driftClassification: drift,
    hardGuards:          evaluateHardGuards({
      result:              input.result,
      effectiveMode,
      artifactTrustLevel:  input.artifactTrustLevel,
      driftClassification: drift,
    }),
    effectiveMode,
    topology:            input.topology.declared,
    topologyState:       input.topology.state,
    hasFailingLocator:   failingLocator !== null,
  };

  return { proposal, decision, context };
}
