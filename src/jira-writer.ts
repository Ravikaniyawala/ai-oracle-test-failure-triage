import { TriageCategory, type TriageResult } from './types.js';

const BASE_URL    = process.env['ATLASSIAN_BASE_URL'];
const TOKEN       = process.env['ATLASSIAN_TOKEN'];
const PROJECT_KEY = process.env['ATLASSIAN_PROJECT_KEY'] ?? 'QA';
const EMAIL       = process.env['ATLASSIAN_EMAIL'] ?? 'oracle@your-org.com';

/**
 * Create a single Jira defect for the given triaged failure.
 * Returns the Jira issue key (e.g. "QA-123") on success, or null on failure /
 * dry-run / missing credentials.
 */
export async function createJiraDefect(result: TriageResult): Promise<string | null> {
  if (process.env['DRY_RUN'] === 'true') {
    console.log('[oracle] DRY_RUN — skipping Jira for', result.testName);
    return null;
  }
  if (!BASE_URL || !TOKEN) {
    console.warn('[oracle] ATLASSIAN_BASE_URL or ATLASSIAN_TOKEN not set, skipping Jira');
    return null;
  }

  const priority = result.category === TriageCategory.REGRESSION ? 'High' : 'Medium';

  const body = {
    fields: {
      project:     { key: PROJECT_KEY },
      summary:     `[AI Oracle] ${result.category}: ${result.testName.slice(0, 100)}`,
      description: {
        type:    'doc',
        version: 1,
        content: [{
          type:    'paragraph',
          content: [{
            type: 'text',
            text: [
              `Category: ${result.category} (confidence: ${(result.confidence * 100).toFixed(0)}%)`,
              `Reasoning: ${result.reasoning}`,
              `Suggested fix: ${result.suggestedFix}`,
              `Error: ${result.errorMessage.slice(0, 500)}`,
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
      console.error(`[oracle] Jira create failed for "${result.testName}":`, await res.text());
      return null;
    }

    const data = await res.json() as { key: string };
    console.log(`[oracle] Jira created: ${data.key} for "${result.testName}"`);
    return data.key;
  } catch (err) {
    console.error('[oracle] Jira write error:', (err as Error).message);
    return null;
  }
}
