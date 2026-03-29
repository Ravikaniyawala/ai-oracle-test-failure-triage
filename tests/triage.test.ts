import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { parseReport } from '../src/report-parser.js';
import { triageFailures } from '../src/triage.js';
import { loadInstincts } from '../src/instinct-loader.js';
import { TriageCategory } from '../src/types.js';

const LOCAL_FIXTURE_JSON = resolve(import.meta.dirname, 'fixtures', 'real-report.json');
const LOCAL_FIXTURE_XML  = resolve(import.meta.dirname, 'fixtures', 'real-report.xml');
const ENV_REPORT         = process.env['PLAYWRIGHT_REPORT_PATH'];

function resolveReportPath(): string | null {
  if (existsSync(LOCAL_FIXTURE_JSON)) return LOCAL_FIXTURE_JSON;
  if (existsSync(LOCAL_FIXTURE_XML))  return LOCAL_FIXTURE_XML;
  if (ENV_REPORT && existsSync(ENV_REPORT)) return ENV_REPORT;
  return null;
}

const reportPath = resolveReportPath();
const hasApiKey  = Boolean(process.env['ANTHROPIC_API_KEY']);

describe('live triage', () => {
  it('classifies all failures from real report', async (t) => {
    if (!reportPath) {
      t.skip('[skip] no report found — set PLAYWRIGHT_REPORT_PATH or place a file at tests/fixtures/real-report.json');
      return;
    }
    if (!hasApiKey) {
      t.skip('[skip] ANTHROPIC_API_KEY not set — skipping live triage test');
      return;
    }

    const parsed = parseReport(reportPath);
    console.log(`[triage.test] using report:   ${reportPath}`);
    console.log(`[triage.test] detected format: ${parsed.detectedFormat}`);
    console.log(`[triage.test] total tests: ${parsed.totalTests}, failures: ${parsed.totalFailures}`);

    const instincts = loadInstincts('./.instincts');
    const results   = await triageFailures(parsed.failures, instincts, parsed.detectedFormat);

    console.log(JSON.stringify(results, null, 2));

    const validCategories = new Set<string>(Object.values(TriageCategory));

    assert.equal(results.length, parsed.failures.length);

    for (const result of results) {
      assert.ok(
        validCategories.has(result.category),
        `category "${result.category}" is not a valid TriageCategory`,
      );
      assert.ok(
        result.confidence >= 0 && result.confidence <= 1,
        `confidence ${result.confidence} out of range for "${result.testName}"`,
      );
      assert.ok(
        result.reasoning.trim().length > 0,
        `empty reasoning for "${result.testName}"`,
      );
      assert.ok(
        result.suggestedFix.trim().length > 0,
        `empty suggestedFix for "${result.testName}"`,
      );
    }
  });
});
