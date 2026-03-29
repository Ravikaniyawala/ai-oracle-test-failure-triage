import { parseReport } from './report-parser.js';
import { triageFailures } from './triage.js';
import { saveRun, saveFailures, initDb } from './state-store.js';
import { writeJiraDefects } from './jira-writer.js';
import { postSlackSummary } from './slack-notifier.js';
import { loadInstincts } from './instinct-loader.js';
import { TriageCategory, type RunSummary, type TriageResult } from './types.js';

const REPORT_PATH = process.env['PLAYWRIGHT_REPORT_PATH'] ?? './playwright-report.json';
const PIPELINE_ID =
  process.env['CI_PIPELINE_ID'] ??
  process.env['GITHUB_RUN_ID'] ??
  `local-${Date.now()}`;

async function main(): Promise<void> {
  try {
    console.log('[oracle] starting triage run', { PIPELINE_ID, REPORT_PATH });

    initDb();

    const parsed = parseReport(REPORT_PATH);
    console.log(`[oracle] detected format: ${parsed.detectedFormat}`);

    if (parsed.failures.length === 0) {
      console.log('[oracle] no failures found, exiting');
      process.exit(0);
    }

    console.log(`[oracle] ${parsed.failures.length} failure(s) from ${parsed.totalTests} total test(s)`);

    const instincts = loadInstincts('./.instincts');
    const results = await triageFailures(parsed.failures, instincts, parsed.detectedFormat);

    const runId = saveRun(PIPELINE_ID, parsed.totalFailures, results);
    saveFailures(runId, results);

    await writeJiraDefects(results);
    await postSlackSummary(results, PIPELINE_ID);

    console.log('[oracle] triage complete', summarise(results));
  } catch (err) {
    console.error('[oracle] fatal error (pipeline continues):', err);
  }
  process.exit(0);
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
