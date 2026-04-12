import { execSync } from 'child_process';
import { appendFileSync, writeFileSync } from 'fs';
import { parseReport } from './report-parser.js';
import { resolveRepoIdentity } from './repo-identity.js';
import { exportSnapshot } from './snapshot-exporter.js';
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
  savePrContext,
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
import { explainDecision, isNotable } from './decision-explainer.js';
import { loadPrContext } from './pr-context-loader.js';
import { getPrRelevance } from './pr-relevance.js';
import {
  TriageCategory,
  type ActionProposal,
  type AgentDecision,
  type AgentProposal,
  type Decision,
  type DecisionEntry,
  type JiraCreated,
  type PatternStats,
  type PrContext,
  type PrRelevance,
  type RunSummary,
  type TriageResult,
} from './types.js';

const REPORT_PATH            = process.env['PLAYWRIGHT_REPORT_PATH']       ?? './playwright-report.json';
const FEEDBACK_PATH          = process.env['ORACLE_FEEDBACK_PATH'];
const AGENT_PROPOSALS_PATH   = process.env['ORACLE_AGENT_PROPOSALS_PATH'];
const PR_CONTEXT_PATH        = process.env['ORACLE_PR_CONTEXT_PATH'];
const PIPELINE_ID            =
  process.env['CI_PIPELINE_ID'] ??
  process.env['GITHUB_RUN_ID'] ??
  `local-${Date.now()}`;

// Output file paths — configurable so parallel invocations can write to separate locations.
// Defaults preserve the existing filenames and cwd-relative behavior.
const VERDICT_PATH          = process.env['ORACLE_VERDICT_PATH']          ?? 'oracle-verdict.json';
const DECISION_SUMMARY_PATH = process.env['ORACLE_DECISION_SUMMARY_PATH'] ?? 'oracle-decision-summary.md';
const SNAPSHOT_ROOT         = process.env['ORACLE_SNAPSHOT_ROOT'] ?? './oracle-snapshots';
const DB_PATH               = process.env['ORACLE_STATE_DB_PATH'] ?? './oracle-state.db';

const REPO_IDENTITY = resolveRepoIdentity();
if (REPO_IDENTITY) {
  console.log(`[oracle] repo identity: ${REPO_IDENTITY.repoId} (${REPO_IDENTITY.repoDisplayName})`);
} else {
  console.log('[oracle] repo identity: unavailable — snapshot export skipped');
}

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
      //    Fetch pattern stats so history rules can apply to retry_test proposals.
      const agentStats    = getPatternStats(proposal.testName, proposal.errorHash);
      const agentDecision = decideAgentProposal(proposal, agentStats);

      // 3. Map to internal ActionProposal + Decision for the shared actions ledger.
      const actionProposal = toActionProposal(proposal, agentDecision.fingerprint);
      const decision       = toDecision(actionProposal, agentDecision);

      // 4. Persist to the shared actions table (INSERT OR IGNORE for idempotency).
      //    This is the unified execution ledger for both policy and agent work.
      //    Returns false when the fingerprint already exists — skip execution,
      //    same as the normal CI path, to prevent duplicate side effects.
      const agentInserted = saveAction(AGENT_MODE_RUN_ID, actionProposal, decision);
      if (!agentInserted) {
        console.log(`[oracle] skipping duplicate agent action ${proposal.proposalType} (fingerprint ${agentDecision.fingerprint})`);
        continue;
      }

      // 5. Update agent_proposals status + link to action fingerprint.
      updateAgentProposalStatus(
        agentProposalId, agentDecision.verdict, agentDecision.reason, agentDecision.fingerprint,
      );

      // Log all notable agent decisions — agents are never auto-approved so most will surface.
      const agentExplanation = explainDecision(
        proposal.proposalType, agentDecision.verdict, agentDecision.reason, agentStats,
      );
      if (isNotable(agentDecision.verdict, agentDecision.reason)) {
        console.log(`[decision] ${agentExplanation} — ${proposal.testName}`);
      }

      if (agentDecision.verdict === 'rejected') {
        continue;
      }

      if (agentDecision.verdict === 'held') {
        heldDecisions.push(agentDecision);
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

    // Load optional PR context for enrichment (read-only — never influences decisions).
    let prContext: PrContext | null = null;
    if (PR_CONTEXT_PATH) {
      prContext = loadPrContext(PR_CONTEXT_PATH);
      if (prContext !== null) {
        // Guard: reject context that belongs to a different pipeline run.
        // Stale or mismatched context would produce incorrect explainability output.
        if (prContext.pipelineId !== PIPELINE_ID) {
          console.warn(
            `[pr-context] pipeline mismatch: expected ${PIPELINE_ID}, got ${prContext.pipelineId}. Skipping PR enrichment.`,
          );
          prContext = null;
        } else {
          savePrContext(prContext);
          console.log(
            `[pr-context] loaded PR #${prContext.prNumber ?? 'n/a'} — ` +
            `${prContext.filesChanged.length} file(s) changed, ` +
            `${prContext.linkedJira.length} linked Jira issue(s)`,
          );
          if (prContext.linkedJira.length > 0) {
            for (const j of prContext.linkedJira) {
              console.log(`[pr-context]   linked: ${j.key}${j.issueType ? ` (${j.issueType})` : ''}${j.title ? ` — ${j.title}` : ''}`);
            }
          }
        }
      }
    }

    if (parsed.failures.length === 0) {
      console.log('[oracle] no failures found — verdict: CLEAR');

      // Persist the CLEAR run so trend charts include clean pipeline runs.
      saveRun(PIPELINE_ID, 0, [], 'CLEAR', REPO_IDENTITY);

      // Write verdict artifact (unchanged structure).
      writeFileSync(VERDICT_PATH, JSON.stringify({
        verdict: 'CLEAR', FLAKY: 0, REGRESSION: 0, NEW_BUG: 0, ENV_ISSUE: 0,
      }, null, 2));

      // Stage 2: export snapshot artifacts if repo identity is available
      if (REPO_IDENTITY) {
        try {
          exportSnapshot({
            snapshotRoot: SNAPSHOT_ROOT,
            identity:     REPO_IDENTITY,
            runId:        PIPELINE_ID,
            timestamp:    new Date().toISOString(),
            verdict:      'CLEAR',
            results:      [],
            dbSourcePath: DB_PATH,
          });
          console.log(`[oracle] snapshot exported to ${SNAPSHOT_ROOT}/repos/${REPO_IDENTITY.repoId}/`);
        } catch (err) {
          console.warn('[oracle] snapshot export failed (non-fatal):', err);
        }
      }

      // Write minimal decision summary artifact.
      writeFileSync(DECISION_SUMMARY_PATH, [
        '# Oracle Decision Summary',
        '',
        '✅ Verdict: CLEAR',
        '',
        '0 failures detected — all tests passed.',
        '',
        'No actions were proposed or executed.',
        '',
      ].join('\n'));

      // Append to GitHub Actions Step Summary if running in Actions.
      const stepSummaryPath = process.env['GITHUB_STEP_SUMMARY'];
      if (stepSummaryPath) {
        appendFileSync(stepSummaryPath, [
          '## ✅ Oracle verdict: CLEAR',
          '',
          '0 failures detected — all tests passed.',
          '',
          'No triage actions were required.',
          '',
        ].join('\n'));
      }

      process.exit(0);
    }

    console.log(`[oracle] ${parsed.failures.length} failure(s) from ${parsed.totalTests} total test(s)`);

    // 1. Classify failures via LLM
    const instincts = loadInstincts('./.instincts');
    const results   = await triageFailures(parsed.failures, instincts, parsed.detectedFormat);

    // 2. Persist run + failures; collect ordered failure IDs.
    //    Verdict is computed here so it can be stored on the run row immediately.
    const summary = summarise(results);
    const verdict = (summary[TriageCategory.REGRESSION] + summary[TriageCategory.NEW_BUG]) > 0
      ? 'BLOCKED' : 'CLEAR';
    const runId      = saveRun(PIPELINE_ID, parsed.totalFailures, results, verdict, REPO_IDENTITY);
    const failureIds = saveFailures(runId, results);

    // 2.5. Compute and log historical pattern stats per failure.
    //      Stats are surfaced before decisions for explainability (Slice 3.1).
    //      They also feed into decision logic for create_jira and retry_test (Slice 3.2).
    const patternStatsMap = new Map<string, PatternStats>();
    for (const result of results) {
      const stats = getPatternStats(result.testName, result.errorHash);
      patternStatsMap.set(`${result.testName}:${result.errorHash}`, stats);
      logPatternStats(result.testName, result.errorHash, stats);
    }

    // 2.6. Compute PR relevance per failure (explainability only — no decision impact).
    const relevanceMap = new Map<string, PrRelevance>();
    if (prContext !== null) {
      for (const result of results) {
        const key       = `${result.testName}:${result.errorHash}`;
        const relevance = getPrRelevance(result.testName, result.file, prContext);
        relevanceMap.set(key, relevance);
        if (relevance.level !== 'low' && relevance.level !== 'unknown') {
          console.log(
            `[pr-relevance] ${relevance.level.toUpperCase()} — ${result.testName}` +
            (relevance.reasons.length > 0 ? ` (${relevance.reasons[0]})` : ''),
          );
        }
      }
    }

    // 3. Propose + decide per-failure actions
    const jiraCreated:  JiraCreated[]    = [];
    const decisionLog:  DecisionEntry[]  = [];

    for (let i = 0; i < results.length; i++) {
      const result    = results[i] as TriageResult;
      const failureId = failureIds[i] as number;

      // Stats for this failure are already in patternStatsMap from step 2.5.
      const failureStats = patternStatsMap.get(`${result.testName}:${result.errorHash}`);

      for (const proposal of proposeFailureActions(result, failureId, runId, PIPELINE_ID)) {
        const jiraAlreadyCreated = proposal.type === 'create_jira'
          ? wasJiraCreatedFor(proposal.fingerprint)
          : false;

        const decision = decide(proposal, result.confidence, {
          jiraAlreadyCreated,
          jiraDuplicateCount: failureStats?.jiraDuplicateCount,
          jiraCreatedCount:   failureStats?.jiraCreatedCount,
        });
        const inserted = saveAction(runId, proposal, decision);

        if (!inserted) {
          console.log(`[oracle] skipping duplicate action ${proposal.type} (fingerprint ${proposal.fingerprint})`);
          continue;
        }

        // Build explanation and collect for summary artifact (all decisions).
        const explanation = explainDecision(proposal.type, decision.verdict, decision.reason, failureStats);
        decisionLog.push({ actionType: proposal.type, verdict: decision.verdict, reason: decision.reason, testName: result.testName, explanation });

        // Log notable decisions only — keeps CI output readable.
        if (isNotable(decision.verdict, decision.reason)) {
          console.log(`[decision] ${explanation} — ${result.testName}`);
        }

        if (decision.verdict !== 'approved') continue;

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

      const explanation = explainDecision(proposal.type, decision.verdict, decision.reason);
      decisionLog.push({ actionType: proposal.type, verdict: decision.verdict, reason: decision.reason, explanation });

      if (isNotable(decision.verdict, decision.reason)) {
        console.log(`[decision] ${explanation}`);
      }

      if (decision.verdict !== 'approved') continue;

      if (proposal.type === 'notify_slack') {
        // Pass history-influenced decisions as compact highlights to Slack.
        const highlights = decisionLog
          .filter(d => d.reason.startsWith('history:'))
          .slice(0, 5)
          .map(d => d.testName ? `${d.explanation} — ${d.testName.slice(0, 60)}` : d.explanation);

        await postSlackSummary(results, jiraCreated, PIPELINE_ID, highlights);
        recordActionExecution(proposal.fingerprint, {
          ok:        true,
          detail:    'slack posted',
          timestamp: new Date().toISOString(),
        });
      }
    }

    // 5. PR comment + summary markdown
    const suppressionCount = decisionLog.filter(d => d.reason.startsWith('history:')).length;
    const slackPosted      = decisionLog.some(d => d.actionType === 'notify_slack' && d.verdict === 'approved');
    const markdown = writeSummary(results, parsed.totalTests, PIPELINE_ID, {
      jirasCreated:    jiraCreated,
      slackPosted,
      suppressionCount,
    });
    await postPrComment(markdown);

    // 6. Verdict file
    const failureSummaries = results.map(r => ({
      testName:      r.testName,
      errorHash:     r.errorHash,
      category:      r.category,
      confidence:    r.confidence,
      pattern_stats: patternStatsMap.get(`${r.testName}:${r.errorHash}`) ?? null,
    }));

    writeFileSync(
      VERDICT_PATH,
      JSON.stringify({ verdict, ...summary, failures: failureSummaries }, null, 2),
    );

    // Stage 2: export snapshot artifacts if repo identity is available
    if (REPO_IDENTITY) {
      try {
        exportSnapshot({
          snapshotRoot: SNAPSHOT_ROOT,
          identity:     REPO_IDENTITY,
          runId:        PIPELINE_ID,
          timestamp:    new Date().toISOString(),
          verdict,
          results,
          dbSourcePath: DB_PATH,
        });
        console.log(`[oracle] snapshot exported to ${SNAPSHOT_ROOT}/repos/${REPO_IDENTITY.repoId}/`);
      } catch (err) {
        console.warn('[oracle] snapshot export failed (non-fatal):', err);
      }
    }

    // 7. Decision summary artifact
    writeDecisionSummary(decisionLog, PIPELINE_ID, parsed.totalFailures, prContext, relevanceMap, results);

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
 *   "Have we seen this before?"         → actions=N
 *   "Did we already create a Jira?"     → jira_created=N
 *   "Were those Jiras useful?"          → jira_duplicates=N
 *   "Do retries usually work?"          → retry_passed=N  retry_failed=N
 */
function logPatternStats(testName: string, errorHash: string, stats: PatternStats): void {
  console.log(`[history] ${testName} (${errorHash})`);
  console.log(`  actions=${stats.actionCount}  jira_created=${stats.jiraCreatedCount}  jira_duplicates=${stats.jiraDuplicateCount}  retry_passed=${stats.retryPassedCount}  retry_failed=${stats.retryFailedCount}`);
}

/**
 * Write oracle-decision-summary.md — a human-readable artifact grouping all
 * decisions by verdict and highlighting history-influenced ones.
 *
 * Sections: Approved · Rejected · Held · History-influenced · PR/Change Context
 * Skipped when decisionLog is empty.
 */
function writeDecisionSummary(
  decisionLog:   DecisionEntry[],
  pipelineId:    string,
  totalFailures: number,
  prContext?:    PrContext | null,
  relevanceMap?: Map<string, PrRelevance>,
  results?:      TriageResult[],
): void {
  if (decisionLog.length === 0) return;

  const approved   = decisionLog.filter(d => d.verdict === 'approved');
  const rejected   = decisionLog.filter(d => d.verdict === 'rejected');
  const held       = decisionLog.filter(d => d.verdict === 'held');
  const historical = decisionLog.filter(d => d.reason.startsWith('history:'));

  const entryLine = (d: DecisionEntry): string =>
    `- \`${d.actionType}\`${d.testName ? ` for "${d.testName}"` : ''} — ${d.explanation.replace(/^[^ ]+ [^ ]+ — /, '')}`;

  const section = (title: string, entries: DecisionEntry[]): string => {
    const header = `## ${title} (${entries.length})`;
    if (entries.length === 0) return `${header}\n_none_`;
    return `${header}\n${entries.map(entryLine).join('\n')}`;
  };

  const lines = [
    `# Oracle Decision Summary — Pipeline ${pipelineId}`,
    '',
    `> ${totalFailures} failure(s) triaged · ${new Date().toISOString()}`,
    '',
    section('Approved', approved),
    '',
    section('Rejected', rejected),
    '',
    section('Held', held),
    '',
    section('History-influenced', historical),
    '',
  ];

  // PR / Change Context section — only when PR context was loaded.
  if (prContext !== null && prContext !== undefined) {
    lines.push('## PR / Change Context');
    lines.push('');

    const meta: string[] = [];
    if (prContext.prNumber !== undefined) meta.push(`PR #${prContext.prNumber}`);
    if (prContext.title    !== undefined) meta.push(`"${prContext.title}"`);
    if (prContext.author   !== undefined) meta.push(`by ${prContext.author}`);
    if (meta.length > 0) lines.push(`**${meta.join(' · ')}**`);

    lines.push('');
    lines.push(`**${prContext.filesChanged.length} file(s) changed** in this PR.`);

    if (prContext.linkedJira.length > 0) {
      lines.push('');
      lines.push('**Linked Jira issues:**');
      for (const j of prContext.linkedJira) {
        const meta: string[] = [];
        if (j.issueType !== undefined) meta.push(j.issueType);
        if (j.team      !== undefined) meta.push(j.team);
        const metaSuffix  = meta.length > 0 ? ` (${meta.join(' · ')})` : '';
        const titleSuffix = j.title !== undefined ? ` — ${j.title}` : '';
        lines.push(`- \`${j.key}\`${metaSuffix}${titleSuffix}`);
      }
    }

    // Per-failure relevance breakdown.
    if (relevanceMap !== undefined && results !== undefined && results.length > 0) {
      const highOrMedium = results.filter(r => {
        const rel = relevanceMap.get(`${r.testName}:${r.errorHash}`);
        return rel?.level === 'high' || rel?.level === 'medium';
      });

      lines.push('');
      lines.push('**Failure relevance to this PR:**');

      if (highOrMedium.length === 0) {
        lines.push('_No failures have high or medium relevance to the changed files._');
      } else {
        for (const r of highOrMedium) {
          const rel = relevanceMap.get(`${r.testName}:${r.errorHash}`) as PrRelevance;
          const reason = rel.reasons.length > 0 ? ` — ${rel.reasons[0]}` : '';
          lines.push(`- **${rel.level.toUpperCase()}** \`${r.testName}\`${reason}`);
        }
      }
    }

    lines.push('');
    lines.push('> ℹ️ PR context is informational only — it does not influence any Oracle decisions.');
    lines.push('');
  }

  writeFileSync(DECISION_SUMMARY_PATH, lines.join('\n'));
  console.log(`[oracle] decision summary written to ${DECISION_SUMMARY_PATH} (${decisionLog.length} decision(s))`);
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
