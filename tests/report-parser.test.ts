import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseReport } from '../src/report-parser.js';
import { ReportFormat } from '../src/types.js';
import { resolve } from 'path';

const fixture = (name: string) => resolve(import.meta.dirname, 'fixtures', name);

// ---------------------------------------------------------------------------
// Playwright JSON
// ---------------------------------------------------------------------------

describe('parseReport — Playwright JSON', () => {
  it('returns zero failures for passing report', () => {
    const result = parseReport(fixture('passing-report.json'));
    assert.equal(result.failures.length, 0);
    assert.equal(result.totalFailures, 0);
    assert.equal(result.detectedFormat, ReportFormat.PLAYWRIGHT_JSON);
  });

  it('returns empty ParseResult for non-existent file', () => {
    const result = parseReport('/tmp/does-not-exist.json');
    assert.equal(result.failures.length, 0);
    assert.equal(result.detectedFormat, ReportFormat.UNKNOWN);
  });

  it('parses flaky report with one timeout failure', () => {
    const result = parseReport(fixture('failing-report-flaky.json'));
    assert.equal(result.failures.length, 1);
    assert.equal(result.totalFailures, 1);
    assert.equal(result.detectedFormat, ReportFormat.PLAYWRIGHT_JSON);

    const f = result.failures[0]!;
    assert.equal(f.testName, 'Dashboard Suite > should load analytics chart');
    assert.equal(f.retries, 2);
    assert.equal(f.duration, 30000);
    assert.ok(f.errorMessage.includes('Timeout'));
    assert.ok(f.errorHash.length > 0);
    assert.equal(f.file, 'tests/dashboard.spec.ts');
  });

  it('parses regression report with two auth failures', () => {
    const result = parseReport(fixture('failing-report-regression.json'));
    assert.equal(result.failures.length, 2);
    assert.ok(result.failures[0]!.errorMessage.includes('401'));
    assert.ok(result.failures[1]!.errorMessage.includes('403'));
    assert.equal(result.failures[0]!.retries, 0);
    assert.equal(result.failures[1]!.retries, 0);
  });

  it('parses env report with certificate and connection failures', () => {
    const result = parseReport(fixture('failing-report-env.json'));
    assert.equal(result.failures.length, 2);
    assert.ok(result.failures[0]!.errorMessage.includes('ERR_CERT_AUTHORITY_INVALID'));
    assert.ok(result.failures[1]!.errorMessage.includes('ERR_CONNECTION_REFUSED'));
  });

  it('generates consistent error hashes for same error', () => {
    const r1 = parseReport(fixture('failing-report-flaky.json'));
    const r2 = parseReport(fixture('failing-report-flaky.json'));
    assert.equal(r1.failures[0]!.errorHash, r2.failures[0]!.errorHash);
  });

  it('generates different error hashes for different errors', () => {
    const result = parseReport(fixture('failing-report-regression.json'));
    assert.notEqual(result.failures[0]!.errorHash, result.failures[1]!.errorHash);
  });

  it('reports correct totalTests count', () => {
    const result = parseReport(fixture('failing-report-flaky.json'));
    assert.equal(result.totalTests, 2); // one passing + one failing spec
  });
});

// ---------------------------------------------------------------------------
// JUnit XML
// ---------------------------------------------------------------------------

describe('parseReport — JUnit XML', () => {
  it('detects format and returns correct counts', () => {
    const result = parseReport(fixture('failing-report-junit.xml'));
    assert.equal(result.detectedFormat, ReportFormat.JUNIT_XML);
    assert.equal(result.failures.length, 2);
    assert.equal(result.totalFailures, 2);
    assert.equal(result.totalTests, 3);
  });

  it('maps testName from suite name and testcase name', () => {
    const result = parseReport(fixture('failing-report-junit.xml'));
    assert.ok(result.failures.some(f => f.testName.includes('testLoginTimeout')));
    assert.ok(result.failures.some(f => f.testName.includes('testGetUserProfile')));
    assert.ok(result.failures.every(f => f.testName.includes('com.example.api.AuthTest')));
  });

  it('converts classname to file path', () => {
    const result = parseReport(fixture('failing-report-junit.xml'));
    assert.ok(result.failures.every(f => f.file === 'com/example/api/AuthTest.java'));
  });

  it('includes failure message in errorMessage', () => {
    const result = parseReport(fixture('failing-report-junit.xml'));
    const timeout = result.failures.find(f => f.testName.includes('testLoginTimeout'))!;
    const auth    = result.failures.find(f => f.testName.includes('testGetUserProfile'))!;
    assert.ok(timeout.errorMessage.toLowerCase().includes('timed out') || timeout.errorMessage.toLowerCase().includes('timeout'));
    assert.ok(auth.errorMessage.includes('401'));
  });

  it('converts time from seconds to milliseconds', () => {
    const result = parseReport(fixture('failing-report-junit.xml'));
    const timeout = result.failures.find(f => f.testName.includes('testLoginTimeout'))!;
    assert.equal(timeout.duration, 5000); // 5.000s → 5000ms
  });

  it('sets retries to 0', () => {
    const result = parseReport(fixture('failing-report-junit.xml'));
    assert.ok(result.failures.every(f => f.retries === 0));
  });

  it('generates consistent error hashes', () => {
    const r1 = parseReport(fixture('failing-report-junit.xml'));
    const r2 = parseReport(fixture('failing-report-junit.xml'));
    assert.equal(r1.failures[0]!.errorHash, r2.failures[0]!.errorHash);
  });
});

// ---------------------------------------------------------------------------
// pytest JSON
// ---------------------------------------------------------------------------

describe('parseReport — pytest JSON', () => {
  it('detects format and returns correct counts', () => {
    const result = parseReport(fixture('failing-report-pytest.json'));
    assert.equal(result.detectedFormat, ReportFormat.PYTEST_JSON);
    assert.equal(result.failures.length, 2);
    assert.equal(result.totalFailures, 2);
    assert.equal(result.totalTests, 3);
  });

  it('maps testName from nodeid last two parts', () => {
    const result = parseReport(fixture('failing-report-pytest.json'));
    assert.ok(result.failures.some(f => f.testName === 'TestAPI > test_connection_timeout'));
    assert.ok(result.failures.some(f => f.testName === 'TestLogin > test_token_refresh'));
  });

  it('maps file from nodeid prefix', () => {
    const result = parseReport(fixture('failing-report-pytest.json'));
    const timeout = result.failures.find(f => f.testName.includes('test_connection_timeout'))!;
    const auth    = result.failures.find(f => f.testName.includes('test_token_refresh'))!;
    assert.equal(timeout.file, 'tests/test_api.py');
    assert.equal(auth.file, 'tests/test_auth.py');
  });

  it('includes longrepr in errorMessage', () => {
    const result = parseReport(fixture('failing-report-pytest.json'));
    const timeout = result.failures.find(f => f.testName.includes('test_connection_timeout'))!;
    const auth    = result.failures.find(f => f.testName.includes('test_token_refresh'))!;
    assert.ok(timeout.errorMessage.includes('ConnectTimeout') || timeout.errorMessage.includes('timeout'));
    assert.ok(auth.errorMessage.includes('403'));
  });

  it('converts duration from seconds to milliseconds', () => {
    const result = parseReport(fixture('failing-report-pytest.json'));
    const timeout = result.failures.find(f => f.testName.includes('test_connection_timeout'))!;
    assert.equal(timeout.duration, 5001); // 5.001s → 5001ms
  });

  it('sets retries to 0', () => {
    const result = parseReport(fixture('failing-report-pytest.json'));
    assert.ok(result.failures.every(f => f.retries === 0));
  });

  it('skips passed tests', () => {
    const result = parseReport(fixture('failing-report-pytest.json'));
    assert.ok(result.failures.every(f => !f.testName.includes('test_valid_credentials')));
  });
});
