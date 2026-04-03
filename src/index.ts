import { parseReport } from './report-parser.js';
import { triageFailures } from './triage.js';
import {
  initDb,
  saveRun,
  saveFailures,
  saveAction,
  recordActionExecution,
  wasJiraCreatedFor,
} from './state-store.js';
import { createJiraDefect } from './jira-writer.js';
import { postSlackSummary } from './slack-notifier.js';
import { loadInstincts } from './instinct-loader.js';
import { writeSummary } from './summary-writer.js';
import { postPrComment } from './pr-commenter.js';
import { proposeFailureActions, proposeRunActions, decide } from './policy-engine.js';
import { ingestFeedback } from './feedback-processor.js';
import { writeFileSync } from 'fs';
import {
  TriageCategory,
  type JiraCreated,
  type RunSummary,
  type TriageResult,
} from './types.js';

const REPORT_PATH   = process.env['PLAYWRIGHT_REPORT_PATH'] ?? './playwright-report.json';
const FEEDBACK_PATH = process.env['ORACLE_FEEDBACK_PATH'];
const PIPELINE_ID   =
  process.env['CI_PIPELINE_ID'] ??
  process.env['GITHUB_RUN_ID'] ??
  `local-${Date.now()}`;

async function main(): Promise<void> {
  // DB must be ready for both modes.
  initDb();

  // ── Feedback ingestion mode ──────────────────────────────────────────────
  // Set ORACLE_FEEDBACK_PATH to a JSON file to ingest feedback and exit.
  // No API key required; safe to run as a post-pipeline step.
  if (FEEDBACK_PATH) {
    console.log('[oracle] feedback ingestion mode:', FEEDBACK_PATH);
    const count = ingestFeedback(FEEDBACK_PATH);
    console.log(`[oracle] ingested ${count} feedback entry/entries`);
    process.exit(0);
  }

  // ── Normal triage mode ───────────────────────────────────────────────────
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
        // History-aware decision: suppress if Jira already created for this signature.
        const jiraAlreadyCreated = proposal.type === 'create_jira'
          ? wasJiraCreatedFor(proposal.fingerprint)
          : false;

        const decision = decide(proposal, result.confidence, { jiraAlreadyCreated });
        const inserted = saveAction(runId, proposal, decision);

        if (!inserted) {
          // Fingerprint already in DB from this exact run — skip silently.
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
