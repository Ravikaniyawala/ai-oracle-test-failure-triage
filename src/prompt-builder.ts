import { type PlaywrightFailure, ReportFormat } from './types.js';

export function buildSystemPrompt(instincts: string[], detectedFormat: ReportFormat): string {
  const instinctBlock = instincts.length > 0
    ? `\n\n## Known patterns (learned from previous runs)\n${instincts.map(i => `- ${i}`).join('\n')}`
    : '';

  return `You are an expert QA engineer triaging test failures.

Test format: ${detectedFormat} — adjust your reasoning accordingly.${formatHint(detectedFormat)}

Classify each failure into exactly one category:
- FLAKY: timing issues, stale selectors, race conditions, transient network errors, retry-able failures
- REGRESSION: a genuine change in app behaviour, API contract break, auth flow break
- ENV_ISSUE: CI environment problem, certificate error, misconfigured proxy
- NEW_BUG: previously unseen failure that does not fit the above

For each failure return:
- category: one of the four above
- confidence: 0.0 to 1.0
- reasoning: one sentence
- suggested_fix: one concrete action the developer should take
- create_jira: true only for REGRESSION and NEW_BUG with confidence > 0.7

Respond ONLY with valid JSON matching this schema:
{
  "results": [
    {
      "testName": "string",
      "category": "FLAKY|REGRESSION|ENV_ISSUE|NEW_BUG",
      "confidence": 0.0,
      "reasoning": "string",
      "suggested_fix": "string",
      "create_jira": false
    }
  ]
}${instinctBlock}`;
}

function formatHint(format: ReportFormat): string {
  switch (format) {
    case ReportFormat.JUNIT_XML:
      return '\nFor JUNIT_XML results from Java/REST Assured, HTTP status codes in error messages indicate API contract failures (likely REGRESSION).\nFor JUNIT_XML results from C# or Python, assertion errors on response bodies are likely REGRESSION, timeouts are likely FLAKY.';
    case ReportFormat.PYTEST_JSON:
      return '\nFor PYTEST_JSON results, AssertionError on HTTP status codes indicates API contract failures (likely REGRESSION). Socket/connection timeouts are likely FLAKY.';
    case ReportFormat.PLAYWRIGHT_API:
      return '\nFor PLAYWRIGHT_API results there is no browser context — failures are HTTP assertion errors. Focus on status codes and response body mismatches.';
    default:
      return '';
  }
}

export function buildUserPrompt(failures: PlaywrightFailure[]): string {
  const failureBlock = failures.map((f, i) =>
    `### Failure ${i + 1}\nTest: ${f.testName}\nFile: ${f.file}\nRetries: ${f.retries}\nError:\n${f.errorMessage.slice(0, 800)}`
  ).join('\n\n');

  return `Triage the following ${failures.length} test failure(s):\n\n${failureBlock}`;
}
