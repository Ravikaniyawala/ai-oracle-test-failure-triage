import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseReport } from '../src/report-parser.js';
import { ReportFormat } from '../src/types.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => resolve(__dirname, 'fixtures', name);

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

  it('throws for non-existent file', () => {
    assert.throws(
      () => parseReport('/tmp/does-not-exist.json'),
      /could not read report path/,
    );
  });

  it('parses JSON reports from a directory recursively', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oracle-report-parser-'));
    try {
      const nested = join(dir, 'nested');
      mkdirSync(nested);
      writeFileSync(
        join(nested, 'report.json'),
        readFileSync(fixture('failing-report-flaky.json'), 'utf8'),
      );

      const result = parseReport(dir);
      assert.equal(result.failures.length, 1);
      assert.equal(result.totalFailures, 1);
      assert.equal(result.detectedFormat, ReportFormat.PLAYWRIGHT_JSON);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when a directory contains no supported report files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oracle-report-parser-empty-'));
    try {
      writeFileSync(join(dir, 'notes.txt'), 'not a test report');
      assert.throws(
        () => parseReport(dir),
        /no supported report files/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression test: previously, a directory containing only a decoy
  // `{"suites": []}` JSON would parse "successfully" with 0 failures, and
  // index.ts would write verdict CLEAR for what was actually a missing
  // report. Directory mode now treats "0 tests across all candidate files"
  // as a parse error so the run goes DEGRADED/BLOCKED instead of shipping.
  it('throws when every parseable candidate in a directory has zero tests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oracle-report-parser-decoy-'));
    try {
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ suites: [] }));
      writeFileSync(join(dir, 'config.json'),   JSON.stringify({ suites: [{ title: 'unused' }] }));
      assert.throws(
        () => parseReport(dir),
        /found 0 tests across all of them/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Sanity check the inverse: one decoy + one real report should still parse,
  // because totalTests > 0 from the real report.
  it('still succeeds when one candidate has zero tests but another has real failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oracle-report-parser-mixed-'));
    try {
      writeFileSync(join(dir, 'decoy.json'), JSON.stringify({ suites: [] }));
      writeFileSync(
        join(dir, 'real.json'),
        readFileSync(fixture('failing-report-flaky.json'), 'utf8'),
      );
      const result = parseReport(dir);
      assert.equal(result.failures.length, 1);
      assert.ok(result.totalTests > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Directory scan must not descend into node_modules / .git / coverage,
  // both for performance and to avoid `.json` decoys (package manifests,
  // coverage data) producing parse warnings or, worse, matching as reports.
  it('skips noise directories (node_modules, .git, coverage) during scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oracle-report-parser-skip-'));
    try {
      mkdirSync(join(dir, 'node_modules'));
      writeFileSync(join(dir, 'node_modules', 'package.json'), JSON.stringify({ name: 'noise', suites: [] }));
      writeFileSync(
        join(dir, 'real.json'),
        readFileSync(fixture('failing-report-flaky.json'), 'utf8'),
      );
      const result = parseReport(dir);
      // Real report has 1 failure — if node_modules was scanned, the decoy
      // would either throw or contribute 0 tests, both detectable.
      assert.equal(result.failures.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Build outputs (`dist`, `build`, `.next`, `target`, `.turbo`, `.vite`)
  // routinely contain stray .json files (chunk manifests, sourcemaps) that
  // would parse as decoys. Walking them is also a performance hazard.
  it('skips build-output and framework-cache directories during scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oracle-report-parser-build-skip-'));
    try {
      // Each of these would, if descended, contribute a decoy `{"suites":[]}`
      // and trip the totalTests==0 directory guard. If even one is skipped,
      // the real report saves the run.
      for (const name of ['dist', 'build', '.next', 'target', '.turbo', '.vite']) {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, 'manifest.json'), JSON.stringify({ suites: [] }));
      }
      writeFileSync(
        join(dir, 'real.json'),
        readFileSync(fixture('failing-report-flaky.json'), 'utf8'),
      );
      const result = parseReport(dir);
      assert.equal(result.failures.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Truncated scans must fail closed. If `findCandidateReportFiles` prunes
  // because a cap fired, returning the partial file list to
  // `parseReportDirectory` is unsafe — the omitted tail might contain the
  // failures, and a partial parse could produce a silent CLEAR. The walker
  // itself stays non-throwing; the close happens at the parser boundary.
  it('fails closed with ReportParseError when ORACLE_MAX_REPORT_VISITED_ENTRIES prunes the scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oracle-report-parser-visited-cap-'));
    try {
      // Many non-report files so the visited-entry counter trips before
      // the directory exhausts. Each .html only increments visited, never
      // candidate count.
      for (let i = 0; i < 20; i++) {
        writeFileSync(join(dir, `chunk-${i.toString().padStart(3, '0')}.html`), '<html />');
      }
      writeFileSync(
        join(dir, 'real.json'),
        readFileSync(fixture('failing-report-flaky.json'), 'utf8'),
      );

      const prev = process.env['ORACLE_MAX_REPORT_VISITED_ENTRIES'];
      process.env['ORACLE_MAX_REPORT_VISITED_ENTRIES'] = '1';
      try {
        assert.throws(
          () => parseReport(dir),
          /scan was truncated.*ORACLE_MAX_REPORT_VISITED_ENTRIES/,
        );
      } finally {
        if (prev === undefined) delete process.env['ORACLE_MAX_REPORT_VISITED_ENTRIES'];
        else                    process.env['ORACLE_MAX_REPORT_VISITED_ENTRIES'] = prev;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The dangerous case: a parseable real report IS already in the
  // candidate list when the cap fires. Without fail-closed, the parser
  // would happily process it and emit a verdict from incomplete data.
  // With fail-closed, the truncation flag wins regardless.
  it('fails closed even when a parseable report was already discovered before the cap fired', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oracle-report-parser-truncate-after-find-'));
    try {
      // The real report. This name sorts ahead of the noise-prefixed
      // dirs alphabetically, so on most filesystems it gets discovered
      // before the cap fires.
      writeFileSync(
        join(dir, '0-real.json'),
        readFileSync(fixture('failing-report-flaky.json'), 'utf8'),
      );
      // A subdirectory full of additional non-report files. The walker
      // increments visited on every entry; with cap=2, we trip after the
      // first child entry.
      mkdirSync(join(dir, 'extras'));
      for (let i = 0; i < 20; i++) {
        writeFileSync(join(dir, 'extras', `noise-${i}.html`), '<html />');
      }

      const prev = process.env['ORACLE_MAX_REPORT_VISITED_ENTRIES'];
      process.env['ORACLE_MAX_REPORT_VISITED_ENTRIES'] = '2';
      try {
        // Even though 0-real.json may have been added to candidates,
        // truncation flag must win and the parser must throw.
        assert.throws(
          () => parseReport(dir),
          /scan was truncated/,
        );
      } finally {
        if (prev === undefined) delete process.env['ORACLE_MAX_REPORT_VISITED_ENTRIES'];
        else                    process.env['ORACLE_MAX_REPORT_VISITED_ENTRIES'] = prev;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A non-truncated scan with no cap hit must still produce CLEAR-on-empty
  // for legitimate single-file passing reports and must not regress
  // directory-mode parsing of real reports.
  it('does not fail closed when no cap is tripped (existing happy path preserved)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oracle-report-parser-happy-'));
    try {
      writeFileSync(
        join(dir, 'real.json'),
        readFileSync(fixture('failing-report-flaky.json'), 'utf8'),
      );
      const result = parseReport(dir);
      assert.equal(result.failures.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
