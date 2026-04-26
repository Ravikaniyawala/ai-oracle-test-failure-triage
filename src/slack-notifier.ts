import { type JiraCreated, type TriageResult, type RunSummary, TriageCategory } from './types.js';

const WEBHOOK_URL = process.env['SLACK_WEBHOOK_URL'];

export async function postSlackSummary(
  results: TriageResult[],
  jiraCreated: JiraCreated[],
  pipelineId: string,
  highlights: string[] = [],
): Promise<void> {
  if (process.env['DRY_RUN'] === 'true') {
    console.log('[oracle] DRY_RUN — skipping Slack, triage result:');
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (!WEBHOOK_URL) {
    console.warn('[oracle] SLACK_WEBHOOK_URL not set, skipping Slack');
    return;
  }

  const counts: RunSummary = {
    [TriageCategory.FLAKY]:      0,
    [TriageCategory.REGRESSION]: 0,
    [TriageCategory.ENV_ISSUE]:  0,
    [TriageCategory.NEW_BUG]:    0,
  };
  for (const r of results) counts[r.category]++;

  const lines = [
    `*AI Oracle — Pipeline ${pipelineId}*`,
    `${results.length} failure(s) triaged`,
    '',
    `FLAKY: ${counts.FLAKY}  |  REGRESSION: ${counts.REGRESSION}  |  ENV: ${counts[TriageCategory.ENV_ISSUE]}  |  NEW BUG: ${counts[TriageCategory.NEW_BUG]}`,
  ];

  if (jiraCreated.length > 0) {
    lines.push('', '*Jira defects created:*');
    for (const f of jiraCreated) {
      const scope = f.clusterSize && f.clusterSize > 1 ? ` — ${f.clusterSize} tests` : '';
      lines.push(`• [${f.key}] ${f.testName.slice(0, 80)}${scope} (${f.category})`);
    }
  }

  if (highlights.length > 0) {
    lines.push('', '*Decision highlights:*');
    for (const h of highlights) {
      lines.push(`• ${h}`);
    }
  }

  try {
    await fetch(WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: lines.join('\n') }),
    });
    console.log('[oracle] Slack summary posted');
  } catch (err) {
    console.error('[oracle] Slack post error:', (err as Error).message);
  }
}
