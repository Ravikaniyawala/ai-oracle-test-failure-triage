import { TriageCategory, type TriageResult } from './types.js';

const BASE_URL   = process.env['ATLASSIAN_BASE_URL'];
const TOKEN      = process.env['ATLASSIAN_TOKEN'];
const PROJECT_KEY = process.env['ATLASSIAN_PROJECT_KEY'] ?? 'QA';
const EMAIL      = process.env['ATLASSIAN_EMAIL'] ?? 'oracle@your-org.com';

export async function writeJiraDefects(results: TriageResult[]): Promise<void> {
  if (process.env['DRY_RUN'] === 'true') {
    console.log('[oracle] DRY_RUN — skipping Jira');
    return;
  }
  if (!BASE_URL || !TOKEN) {
    console.warn('[oracle] ATLASSIAN_BASE_URL or ATLASSIAN_TOKEN not set, skipping Jira');
    return;
  }

  const toCreate = results.filter(r => r.createJira);
  if (toCreate.length === 0) {
    console.log('[oracle] no Jira defects to create');
    return;
  }

  for (const failure of toCreate) {
    await createDefect(failure);
  }
}

async function createDefect(failure: TriageResult): Promise<void> {
  const priority = failure.category === TriageCategory.REGRESSION ? 'High' : 'Medium';

  const body = {
    fields: {
      project:     { key: PROJECT_KEY },
      summary:     `[AI Oracle] ${failure.category}: ${failure.testName.slice(0, 100)}`,
      description: {
        type:    'doc',
        version: 1,
        content: [{
          type:    'paragraph',
          content: [{
            type: 'text',
            text: [
              `Category: ${failure.category} (confidence: ${(failure.confidence * 100).toFixed(0)}%)`,
              `Reasoning: ${failure.reasoning}`,
              `Suggested fix: ${failure.suggestedFix}`,
              `Error: ${failure.errorMessage.slice(0, 500)}`,
            ].join('\n\n'),
          }],
        }],
      },
      issuetype: { name: 'Bug' },
      priority:  { name: priority },
      labels:    ['ai-oracle', 'automated'],
    },
  };

  try {
    const res = await fetch(`${BASE_URL}/rest/api/3/issue`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`[oracle] Jira create failed for "${failure.testName}":`, await res.text());
      return;
    }

    const data = await res.json() as { key: string };
    console.log(`[oracle] Jira created: ${data.key} for "${failure.testName}"`);
  } catch (err) {
    console.error('[oracle] Jira write error:', (err as Error).message);
  }
}
