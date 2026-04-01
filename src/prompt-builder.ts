import { type PlaywrightFailure, ReportFormat } from './types.js';

export function buildSystemPrompt(instincts: string[], detectedFormat: ReportFormat): string {
  const instinctBlock = instincts.length > 0
    ? `\n\n## Known patterns (learned from previous runs)\n${instincts.map(i => `- ${i}`).join('\n')}`
    : '';

  return `You are an expert QA engineer triaging test failures.

Test format: ${detectedFormat} — adjust your reasoning accordingly.${formatHint(detectedFormat)}

Classify each failure into exactly one category:
- FLAKY: timing issues, duration/response-time assertions, race conditions, transient network errors, retry-able failures. Key signals: test name contains "delayed", "timeout", "slow", "retry"; assertion compares milliseconds or response time.
- REGRESSION: a behaviour that previously worked is now broken. Key signals: wrong value returned by an existing endpoint (e.g. price mismatch, wrong count on a known resource), API contract changed for a feature that exists.
- ENV_ISSUE: CI environment problem, certificate error, misconfigured proxy, missing env variable.
- NEW_BUG: an endpoint or feature that was never implemented or is structurally absent. Key signals: 404 on an endpoint that should exist, feature flagged as missing, endpoint never previously seen passing.

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
      return `
For JUNIT_XML (Java/REST Assured) use these rules in order:

1. FLAKY   — assertion compares response time or duration in ms; test name contains words like "delayed", "slow", "timeout", "retry", "timing".
2. NEW_BUG — response is 404 / 405 / 501 on an endpoint that should exist; error says "endpoint not found" or "not implemented"; the test name suggests a feature (e.g. "bulk", "export", "upload") with no prior passing history.
3. REGRESSION — an existing endpoint returns the wrong value (wrong price, wrong count, wrong field); a previously-passing assertion now fails because data or logic changed.
4. ENV_ISSUE — connection refused, SSL error, DNS failure, missing environment variable, CI infrastructure problem.

Do NOT default everything to REGRESSION. Read the test name and error message carefully to distinguish a missing feature (NEW_BUG) from a changed value (REGRESSION) from a timing assertion (FLAKY).`;
    case ReportFormat.PYTEST_JSON:
      return '\nFor PYTEST_JSON: 404/501 on missing endpoints = NEW_BUG. Wrong returned value on existing endpoint = REGRESSION. Socket/connection timeouts or duration assertions = FLAKY.';
    case ReportFormat.PLAYWRIGHT_API:
      return '\nFor PLAYWRIGHT_API: no browser context — failures are HTTP assertion errors. 404 on missing feature = NEW_BUG. Wrong value on existing endpoint = REGRESSION. Timeout = FLAKY.';
    default:
      return '';
  }
}

export function buildUserPrompt(failures: PlaywrightFailure[]): string {
  const failureBlock = failures.map((f, i) => {
    const durationNote = f.duration > 0 ? `Duration: ${f.duration}ms` : '';
    return [
      `### Failure ${i + 1}`,
      `Test name: ${f.testName}`,
      `File: ${f.file}`,
      `Retries: ${f.retries}`,
      durationNote,
      `Error:\n${f.errorMessage.slice(0, 800)}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  return `Triage the following ${failures.length} test failure(s). Read each test name carefully — it often reveals whether the feature is missing (NEW_BUG), broken (REGRESSION), or timing-dependent (FLAKY).\n\n${failureBlock}`;
}
