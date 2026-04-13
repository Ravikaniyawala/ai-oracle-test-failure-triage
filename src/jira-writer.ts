import { TriageCategory, type TriageResult } from './types.js';

// Read Atlassian credentials dynamically so that tests can set/clear env vars
// without worrying about module-load-time capture.
function getCredentials(): { baseUrl: string; token: string; email: string; projectKey: string } | null {
  const baseUrl    = process.env['ATLASSIAN_BASE_URL'];
  const token      = process.env['ATLASSIAN_TOKEN'];
  const email      = process.env['ATLASSIAN_EMAIL'];
  const projectKey = process.env['ATLASSIAN_PROJECT_KEY'] ?? 'QA';
  if (!baseUrl || !token || !email) return null;
  return { baseUrl, token, email, projectKey };
}

/**
 * Return a deterministic Jira label derived from the action fingerprint.
 * Attached to every Oracle-created issue so that future runs — and concurrent
 * runners — can search for it before filing a new ticket.
 */
export function oracleFpLabel(fingerprint: string): string {
  return `oracle-fp-${fingerprint}`;
}

/**
 * Search Jira for an existing unresolved issue in the project with the given
 * fingerprint label.  Returns the issue key (e.g. "QA-123") if found, or null
 * if no match or if the search request fails.
 *
 * Failure is non-fatal: a failed search falls through to creation so that a
 * transient API error does not silently suppress Jira filing.
 */
export async function findExistingJiraByFingerprint(
  fingerprint: string,
): Promise<string | null> {
  const creds = getCredentials();
  if (!creds) return null;

  const { baseUrl, token, email, projectKey } = creds;
  const label = oracleFpLabel(fingerprint);
  const jql   = `project = "${projectKey}" AND labels = "${label}" AND resolution = Unresolved`;

  try {
    const res = await fetch(
      `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=1&fields=key`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
        },
      },
    );

    if (!res.ok) {
      console.warn('[oracle] Jira search failed (non-fatal):', res.status, await res.text());
      return null;
    }

    const data = await res.json() as { issues: Array<{ key: string }> };
    if (data.issues.length > 0) {
      const key = data.issues[0]!.key;
      console.log(`[oracle] Jira idempotency: found existing issue ${key} for fingerprint ${fingerprint} — skipping creation`);
      return key;
    }
    return null;
  } catch (err) {
    console.warn('[oracle] Jira search error (non-fatal):', (err as Error).message);
    return null;
  }
}

export interface JiraDefectResult {
  /** Jira issue key, e.g. "QA-123". */
  key:         string;
  /**
   * true  — a new issue was created by this call.
   * false — an existing unresolved issue with the oracle-fp label was found;
   *         creation was skipped.  Should NOT be counted as a new Jira in
   *         metrics or run summaries.
   */
  wasExisting: boolean;
}

/**
 * Create a single Jira defect for the given triaged failure.
 *
 * Duplicate-reduction flow (best-effort, not atomic):
 *   1. Local SQLite dedupe (wasJiraCreatedFor) — fast path, checked by caller.
 *   2. Jira label search — searches for an unresolved issue in the same project
 *      with label `oracle-fp-<fingerprint>` before creating.  Catches races
 *      where two runners both passed step 1 on a stale cache snapshot.
 *      NOTE: search and create are not atomic — two runners can both search
 *      before either creates and still produce a duplicate.  This is a
 *      best-effort mitigation, not a hard guarantee.
 *   3. Create — attaches `oracle-fp-<fingerprint>` label so future runs and
 *      concurrent runners can find the issue in step 2.
 *
 * Returns a JiraDefectResult on success (key + whether it was newly created),
 * or null on failure / dry-run / missing credentials.
 */
export async function createJiraDefect(
  result:      TriageResult,
  fingerprint: string,
): Promise<JiraDefectResult | null> {
  if (process.env['DRY_RUN'] === 'true') {
    console.log('[oracle] DRY_RUN — skipping Jira for', result.testName);
    return null;
  }
  const creds = getCredentials();
  if (!creds) {
    console.warn('[oracle] ATLASSIAN_BASE_URL, ATLASSIAN_TOKEN, or ATLASSIAN_EMAIL not set — skipping Jira');
    return null;
  }

  // Jira-side duplicate-reduction check: search before create (best-effort).
  const existing = await findExistingJiraByFingerprint(fingerprint);
  if (existing !== null) return { key: existing, wasExisting: true };

  const { baseUrl, token, email, projectKey } = creds;
  const priority = result.category === TriageCategory.REGRESSION ? 'High' : 'Medium';
  const fpLabel  = oracleFpLabel(fingerprint);

  const body = {
    fields: {
      project:     { key: projectKey },
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
      labels:    ['ai-oracle', 'automated', fpLabel],
    },
  };

  try {
    const res = await fetch(`${baseUrl}/rest/api/3/issue`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`[oracle] Jira create failed for "${result.testName}":`, await res.text());
      return null;
    }

    const data = await res.json() as { key: string };
    console.log(`[oracle] Jira created: ${data.key} for "${result.testName}" [${fpLabel}]`);
    return { key: data.key, wasExisting: false };
  } catch (err) {
    console.error('[oracle] Jira write error:', (err as Error).message);
    return null;
  }
}
