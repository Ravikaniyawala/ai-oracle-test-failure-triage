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
  type AgentDecision,
  type JiraCreated,
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
      const agentProposalId = saveAgentProposal(proposal);
      const decision        = decideAgentProposal(proposal);

      if (decision.verdict === 'rejected') {
        updateAgentProposalStatus(agentProposalId, 'rejected', decision.reason, decision.fingerprint);
        console.log(`[oracle] agent proposal rejected: ${proposal.proposalType} — ${decision.reason}`);
        continue;
      }

      if (decision.verdict === 'held') {
        updateAgentProposalStatus(agentProposalId, 'held', decision.reason, decision.fingerprint);
        heldDecisions.push(decision);
        console.log(`[oracle] agent proposal held: ${proposal.proposalType} — ${decision.reason}`);
        continue;
      }

      // approved — execute if the proposal type has an executor
      updateAgentProposalStatus(agentProposalId, 'approved', decision.reason, decision.fingerprint);

      if (proposal.proposalType === 'retry_test') {
        const ok = executeRetry(proposal.testName);
        updateAgentProposalStatus(agentProposalId, 'executed', decision.reason, decision.fingerprint);
        saveFeedback({
          feedbackType: ok ? 'retry_passed' : 'retry_failed',
          pipelineId:   proposal.pipelineId,
          testName:     proposal.testName,
          errorHash:    proposal.errorHash,
          notes:        ok ? 'retry command succeeded' : 'retry command failed or was not configured',
          createdAt:    new Date().toISOString(),
        });
        continue;
      }

      if (proposal.proposalType === 'request_human_review') {
        // Low-risk acknowledgement only — no external side effect.
        updateAgentProposalStatus(agentProposalId, 'executed', decision.reason, decision.fingerprint);
        console.log(`[oracle] request_human_review recorded for "${proposal.testName}"`);
        continue;
      }

      // Should never reach here — decideAgentProposal rejects unknown types.
      // Guard against any future inconsistency.
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
    writeFileSync(
      'oracle-verdict.json',
      JSON.stringify({ verdict, ...summary }, null, 2),
    );

    console.log('[oracle] triage complete', summary);
  } catch (err) {
    console.error('[oracle] fatal error:', err);
    process.exit(1);
  }
}

/**
 * Execute the retry command specified in RETRY_COMMAND env var.
 *
 * Returns true if the command exits with code 0, false otherwise.
 * If RETRY_COMMAND is not set, logs and returns false — does NOT throw.
 */
function executeRetry(testName: string): boolean {
  const cmd = process.env['RETRY_COMMAND'];
  if (!cmd) {
    console.log(`[oracle] RETRY_COMMAND not set — skipping retry execution for "${testName}"`);
    return false;
  }

  try {
    console.log(`[oracle] executing retry for "${testName}": ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });
    console.log(`[oracle] retry succeeded for "${testName}"`);
    return true;
  } catch {
    console.log(`[oracle] retry failed for "${testName}"`);
    return false;
  }
}

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
