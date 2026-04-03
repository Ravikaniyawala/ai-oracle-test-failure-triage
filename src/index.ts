import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { parseReport } from './report-parser.js';
import { triageFailures } from './triage.js';
import {
  initDb,
  saveRun,
  saveFailures,
  saveAction,
  recordActionExecution,
  wasJiraCreatedFor,
  saveFeedback,
  saveAgentProposal,
  updateAgentProposalStatus,
  getPatternStats,
} from './state-store.js';
import { createJiraDefect } from './jira-writer.js';
import { postSlackSummary } from './slack-notifier.js';
import { loadInstincts } from './instinct-loader.js';
import { writeSummary } from './summary-writer.js';
import { postPrComment } from './pr-commenter.js';
import { proposeFailureActions, proposeRunActions, decide, decideAgentProposal } from './policy-engine.js';
import { ingestFeedback } from './feedback-processor.js';
import { loadAgentProposals } from './agent-proposal-loader.js';
import { writeHeldActions } from './held-actions-writer.js';
import {
  TriageCategory,
  type ActionProposal,
  type AgentDecision,
  type AgentProposal,
  type Decision,
  type JiraCreated,
  type PatternStats,
  type RunSummary,
  type TriageResult,
} from './types.js';

const REPORT_PATH          = process.env['PLAYWRIGHT_REPORT_PATH']    ?? './playwright-report.json';
const FEEDBACK_PATH        = process.env['ORACLE_FEEDBACK_PATH'];
const AGENT_PROPOSALS_PATH = process.env['ORACLE_AGENT_PROPOSALS_PATH'];
const PIPELINE_ID          =
  process.env['CI_PIPELINE_ID'] ??
  process.env['GITHUB_RUN_ID'] ??
  `local-${Date.now()}`;

// Sentinel run_id used for agent-proposal-mode actions (no CI run exists).
// SQLite FK constraints are not enforced without PRAGMA foreign_keys = ON.
const AGENT_MODE_RUN_ID = 0;

async function main(): Promise<void> {
  // DB must be ready for all modes.
  initDb();

  // ── Mode 1: Feedback ingestion ───────────────────────────────────────────
  // Set ORACLE_FEEDBACK_PATH to a JSON file to ingest feedback and exit.
  // No API key required; safe to run as a post-pipeline step.
  if (FEEDBACK_PATH) {
    console.log('[oracle] feedback ingestion mode:', FEEDBACK_PATH);
    const count = ingestFeedback(FEEDBACK_PATH);
    console.log(`[oracle] ingested ${count} feedback entry/entries`);
    process.exit(0);
  }

  // ── Mode 2: Agent proposal ingestion ────────────────────────────────────
  // Set ORACLE_AGENT_PROPOSALS_PATH to a JSON file to process agent proposals
  // and exit. No API key required.
  if (AGENT_PROPOSALS_PATH) {
    console.log('[oracle] agent proposal mode:', AGENT_PROPOSALS_PATH);
    const proposals = loadAgentProposals(AGENT_PROPOSALS_PATH);
    console.log(`[oracle] ${proposals.length} valid proposal(s) loaded`);

    const heldDecisions: AgentDecision[] = [];

    for (const proposal of proposals) {
      // 1. Save intake record in agent_proposals (status: received).
      const agentProposalId = saveAgentProposal(proposal);

      // 2. Run through the decision layer — agents are never trusted executors.
      const agentDecision  = decideAgentProposal(proposal);

      // 3. Map to internal ActionProposal + Decision for the shared actions ledger.
      const actionProposal = toActionProposal(proposal, agentDecision.fingerprint);
      const decision       = toDecision(actionProposal, agentDecision);

      // 4. Persist to the shared actions table (INSERT OR IGNORE for idempotency).
      //    This is the unified execution ledger for both policy and agent work.
      saveAction(AGENT_MODE_RUN_ID, actionProposal, decision);

      // 5. Update agent_proposals status + link to action fingerprint.
      updateAgentProposalStatus(
        agentProposalId, agentDecision.verdict, agentDecision.reason, agentDecision.fingerprint,
      );

      if (agentDecision.verdict === 'rejected') {
        console.log(`[oracle] agent proposal rejected: ${proposal.proposalType} — ${agentDecision.reason}`);
        continue;
      }

      if (agentDecision.verdict === 'held') {
        heldDecisions.push(agentDecision);
        console.log(`[oracle] agent proposal held: ${proposal.proposalType} — ${agentDecision.reason}`);
        continue;
      }

      // 6. Approved — execute if the proposal type has an executor.

      if (proposal.proposalType === 'retry_test') {
        const outcome = executeRetry(proposal.testName);

        // Record execution result in the shared actions ledger.
        recordActionExecution(agentDecision.fingerprint, {
          ok:        outcome === 'passed',
          detail:    outcome === 'skipped'
            ? 'skipped:no_retry_command'
            : outcome === 'passed' ? 'retry command succeeded' : 'retry command failed',
          timestamp: new Date().toISOString(),
        });

        updateAgentProposalStatus(
          agentProposalId, 'executed', agentDecision.reason, agentDecision.fingerprint,
        );

        // Only persist feedback for real retry outcomes — not skips.
        // 'skipped' means RETRY_COMMAND was never set; there is no meaningful outcome.
        if (outcome !== 'skipped') {
          saveFeedback({
            feedbackType: outcome === 'passed' ? 'retry_passed' : 'retry_failed',
            pipelineId:   proposal.pipelineId,
            testName:     proposal.testName,
            errorHash:    proposal.errorHash,
            notes:        outcome === 'passed' ? 'retry command succeeded' : 'retry command failed',
            createdAt:    new Date().toISOString(),
          });
        }
        continue;
      }

      if (proposal.proposalType === 'request_human_review') {
        // Low-risk acknowledgement only — no external side effect.
        recordActionExecution(agentDecision.fingerprint, {
          ok:        true,
          detail:    'request_human_review acknowledged',
          timestamp: new Date().toISOString(),
        });
        updateAgentProposalStatus(
          agentProposalId, 'executed', agentDecision.reason, agentDecision.fingerprint,
        );
        console.log(`[oracle] request_human_review recorded for "${proposal.testName}"`);
        continue;
      }

      // Should never reach here — decideAgentProposal rejects unknown types.
      console.warn(`[oracle] approved proposal type "${proposal.proposalType}" has no executor — skipping`);
    }

    if (heldDecisions.length > 0) {
      writeHeldActions(heldDecisions);
    }

    process.exit(0);
  }

  // ── Mode 3: Normal CI triage ─────────────────────────────────────────────
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('[oracle] ANTHROPIC_API_KEY is not set — cannot triage');
    process.exit(1);
  }

  try {
    console.log('[oracle] starting triage run', { PIPELINE_ID, REPORT_PATH });

    const parsed = parseReport(REPORT_PATH);
    console.log(`[oracle] detected format: ${parsed.detectedFormat}`);

    if (parsed.failures.length === 0) {
      console.log('[oracle] no failures found, exiting');
      writeFileSync('oracle-verdict.json', JSON.stringify({
        verdict: 'CLEAR', FLAKY: 0, REGRESSION: 0, NEW_BUG: 0, ENV_ISSUE: 0,
      }, null, 2));
      process.exit(0);
    }

    console.log(`[oracle] ${parsed.failures.length} failure(s) from ${parsed.totalTests} total test(s)`);

    // 1. Classify failures via LLM
    const instincts = loadInstincts('./.instincts');
    const results   = await triageFailures(parsed.failures, instincts, parsed.detectedFormat);

    // 2. Persist run + failures; collect ordered failure IDs
    const runId      = saveRun(PIPELINE_ID, parsed.totalFailures, results);
    const failureIds = saveFailures(runId, results);

    // 2.5. Log historical pattern stats for each failure (explainability, read-only).
    //      These are surfaced before decisions are made so operators can see context.
    //      Stats reflect what has happened in past runs — they do not influence decisions.
    const patternStatsMap = new Map<string, PatternStats>();
    for (const result of results) {
      const stats = getPatternStats(result.testName, result.errorHash);
      patternStatsMap.set(`${result.testName}:${result.errorHash}`, stats);
      logPatternStats(result.testName, result.errorHash, stats);
    }

    // 3. Propose + decide per-failure actions
    const jiraCreated: JiraCreated[] = [];

    for (let i = 0; i < results.length; i++) {
      const result    = results[i] as TriageResult;
      const failureId = failureIds[i] as number;

      for (const proposal of proposeFailureActions(result, failureId, runId, PIPELINE_ID)) {
        const jiraAlreadyCreated = proposal.type === 'create_jira'
          ? wasJiraCreatedFor(proposal.fingerprint)
          : false;

        const decision = decide(proposal, result.confidence, { jiraAlreadyCreated });
        const inserted = saveAction(runId, proposal, decision);

        if (!inserted) {
          console.log(`[oracle] skipping duplicate action ${proposal.type} (fingerprint ${proposal.fingerprint})`);
          continue;
        }

        if (decision.verdict !== 'approved') {
          console.log(`[oracle] action ${proposal.type} ${decision.verdict} — ${decision.reason}`);
          continue;
        }

        if (proposal.type === 'create_jira') {
          const key = await createJiraDefect(result);
          recordActionExecution(proposal.fingerprint, {
            ok:        key !== null,
            detail:    key ?? 'create_jira failed or skipped',
            timestamp: new Date().toISOString(),
          });
          if (key !== null) {
            jiraCreated.push({ testName: result.testName, category: result.category, key });
          }
        }
      }
    }

    // 4. Propose + decide run-level actions
    for (const proposal of proposeRunActions(runId, PIPELINE_ID)) {
      const decision = decide(proposal, 1.0);
      const inserted = saveAction(runId, proposal, decision);

      if (!inserted) {
        console.log(`[oracle] skipping duplicate action ${proposal.type} (fingerprint ${proposal.fingerprint})`);
        continue;
      }

      if (decision.verdict !== 'approved') {
        console.log(`[oracle] action ${proposal.type} ${decision.verdict} — ${decision.reason}`);
        continue;
      }

      if (proposal.type === 'notify_slack') {
        await postSlackSummary(results, jiraCreated, PIPELINE_ID);
        recordActionExecution(proposal.fingerprint, {
          ok:        true,
          detail:    'slack posted',
          timestamp: new Date().toISOString(),
        });
      }
    }

    // 5. PR comment + summary markdown
    const markdown = writeSummary(results, parsed.totalTests, PIPELINE_ID);
    await postPrComment(markdown);

    // 6. Verdict file
    const summary = summarise(results);
    const verdict = (summary[TriageCategory.REGRESSION] + summary[TriageCategory.NEW_BUG]) > 0
      ? 'BLOCKED' : 'CLEAR';

    const failureSummaries = results.map(r => ({
      testName:      r.testName,
      errorHash:     r.errorHash,
      category:      r.category,
      confidence:    r.confidence,
      pattern_stats: patternStatsMap.get(`${r.testName}:${r.errorHash}`) ?? null,
    }));

    writeFileSync(
      'oracle-verdict.json',
      JSON.stringify({ verdict, ...summary, failures: failureSummaries }, null, 2),
    );

    console.log('[oracle] triage complete', summary);
  } catch (err) {
    console.error('[oracle] fatal error:', err);
    process.exit(1);
  }
}

// ── Agent proposal helpers ────────────────────────────────────────────────────

/**
 * Map an agent proposal + its fingerprint into the internal ActionProposal
 * shape so it can flow through saveAction() into the shared actions ledger.
 *
 * runId is 0 (AGENT_MODE_RUN_ID) — agent proposals have no CI run.
 * SQLite FK constraints are not enforced without PRAGMA foreign_keys = ON,
 * so 0 is a safe sentinel value here.
 */
function toActionProposal(proposal: AgentProposal, fingerprint: string): ActionProposal {
  return {
    type:        proposal.proposalType as ActionProposal['type'],
    scope:       'failure',
    scopeId:     `${proposal.testName}:${proposal.errorHash}`,
    failureId:   null,
    clusterKey:  null,
    runId:       AGENT_MODE_RUN_ID,
    pipelineId:  proposal.pipelineId,
    source:      'agent',
    fingerprint,
  };
}

/**
 * Map an AgentDecision into the internal Decision shape so it can be passed
 * to saveAction().  AgentVerdict ('approved' | 'held' | 'rejected') is a
 * subset of DecisionVerdict (which now includes 'held').
 */
function toDecision(actionProposal: ActionProposal, agentDecision: AgentDecision): Decision {
  return {
    proposal:   actionProposal,
    verdict:    agentDecision.verdict,
    confidence: agentDecision.proposal.confidence,
    reason:     agentDecision.reason,
  };
}

// ── Retry execution ───────────────────────────────────────────────────────────

type RetryOutcome = 'passed' | 'failed' | 'skipped';

/**
 * Execute the retry command specified in RETRY_COMMAND env var.
 *
 * Returns:
 *   'passed'  — command ran and exited 0
 *   'failed'  — command ran and exited non-zero
 *   'skipped' — RETRY_COMMAND not set; command was never executed
 *
 * Never throws.  Callers must treat 'skipped' as a no-op for feedback purposes.
 */
function executeRetry(testName: string): RetryOutcome {
  const cmd = process.env['RETRY_COMMAND'];
  if (!cmd) {
    console.log(`[oracle] RETRY_COMMAND not set — skipping retry execution for "${testName}"`);
    return 'skipped';
  }

  try {
    console.log(`[oracle] executing retry for "${testName}": ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });
    console.log(`[oracle] retry succeeded for "${testName}"`);
    return 'passed';
  } catch {
    console.log(`[oracle] retry failed for "${testName}"`);
    return 'failed';
  }
}

// ── Explainability helpers ────────────────────────────────────────────────────

/**
 * Log historical pattern stats for a failure in a structured, human-readable format.
 *
 * Helps answer:
 *   "Have we seen this before?"         → seen=N
 *   "Did we already create a Jira?"     → jira_created=N
 *   "Were those Jiras useful?"          → jira_duplicates=N
 *   "Do retries usually work?"          → retry_passed=N  retry_failed=N
 */
function logPatternStats(testName: string, errorHash: string, stats: PatternStats): void {
  console.log(`[history] ${testName} (${errorHash})`);
  console.log(`  seen=${stats.seenCount}  jira_created=${stats.jiraCreatedCount}  jira_duplicates=${stats.jiraDuplicateCount}  retry_passed=${stats.retryPassedCount}  retry_failed=${stats.retryFailedCount}`);
}

// ── Summary helper ────────────────────────────────────────────────────────────

function summarise(results: TriageResult[]): RunSummary {
  const counts: RunSummary = {
    [TriageCategory.FLAKY]:      0,
    [TriageCategory.REGRESSION]: 0,
    [TriageCategory.ENV_ISSUE]:  0,
    [TriageCategory.NEW_BUG]:    0,
  };
  for (const r of results) counts[r.category]++;
  return counts;
}

main();
