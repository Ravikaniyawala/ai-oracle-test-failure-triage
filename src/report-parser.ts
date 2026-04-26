import { readFileSync, statSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { extname, join } from 'path';
import { XMLParser } from 'fast-xml-parser';
import { type PlaywrightFailure, ReportFormat, type ParseResult } from './types.js';

export class ReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportParseError';
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function parseReport(reportPath: string): ParseResult {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(reportPath);
  } catch (err) {
    throw new ReportParseError(`could not read report path ${reportPath}: ${(err as Error).message}`);
  }

  if (stat.isDirectory()) {
    return parseReportDirectory(reportPath);
  }

  return parseReportFile(reportPath);
}

function parseReportDirectory(reportPath: string): ParseResult {
  const { files, truncatedReason } = findCandidateReportFiles(reportPath);

  // Fail closed when the walker pruned. A partial file list could omit the
  // tail that contains the failures, and `parseReportDirectory` would then
  // hand index.ts an artificially-clean ParseResult — turning a truncated
  // scan into a silent CLEAR. The walker stays non-throwing (it logs +
  // returns); the close happens here so callers see one clear error.
  if (truncatedReason !== null) {
    throw new ReportParseError(
      `report directory scan was truncated (${truncatedReason}) under ${reportPath} — ` +
      `partial results are not safe to verdict on. Raise the cap via env var or narrow the scan path.`,
    );
  }

  if (files.length === 0) {
    throw new ReportParseError(`no supported report files (.json or .xml) found in directory ${reportPath}`);
  }

  console.log(`[oracle] scanning directory: found ${files.length} candidate report file(s)`);

  const parts: Array<{ file: string; result: ParseResult }> = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      parts.push({ file, result: parseReportFile(file) });
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
    }
  }

  if (parts.length === 0) {
    throw new ReportParseError(
      `no parseable reports found in directory ${reportPath}` +
      (errors.length > 0 ? `; ${errors.join('; ')}` : ''),
    );
  }

  // Surface per-file parse errors with paths, not just a count, so misconfigured
  // artifacts that drop a real report alongside several noise files are easy to
  // diagnose. We log even on the success path because the previous count-only
  // log made "is my real report being silently skipped?" hard to answer.
  if (errors.length > 0) {
    console.warn(`[oracle] skipped ${errors.length} unparseable candidate report file(s):`);
    for (const e of errors) console.warn(`  - ${e}`);
  }

  // Guard against the silent-CLEAR regression: if every parseable file reports
  // zero tests, treat the directory as having no real report. Without this
  // check, a stray `{"suites": []}` JSON in an artifact (a CI manifest, a
  // crashed test step's empty file, an unrelated config dumped to JSON) parses
  // "successfully" with 0 failures, then `index.ts` writes verdict CLEAR and
  // ships. Single-file callers retain CLEAR-on-empty for the legitimate
  // passing-run case — the guard is directory-mode only.
  const totalTests = parts.reduce((sum, p) => sum + p.result.totalTests, 0);
  if (totalTests === 0) {
    const fileList = parts.map(p => p.file).join(', ');
    throw new ReportParseError(
      `parsed ${parts.length} candidate report file(s) under ${reportPath} but found 0 tests across all of them — ` +
      `the real test report is likely missing or the test step did not produce output. Files scanned: ${fileList}`,
    );
  }

  const formats = new Set(parts.map(p => p.result.detectedFormat));
  return {
    failures:       parts.flatMap(p => p.result.failures),
    detectedFormat: formats.size === 1 ? parts[0]!.result.detectedFormat : ReportFormat.UNKNOWN,
    totalTests,
    totalFailures:  parts.reduce((sum, p) => sum + p.result.totalFailures, 0),
  };
}

function parseReportFile(reportPath: string): ParseResult {
  let content: string;
  try {
    content = readFileSync(reportPath, 'utf8');
  } catch (err) {
    throw new ReportParseError(`could not read report file ${reportPath}: ${(err as Error).message}`);
  }

  const formatOverride = process.env['REPORT_FORMAT'];
  const ext = extname(reportPath).toLowerCase();

  let format: ReportFormat;
  if (formatOverride && isValidFormat(formatOverride)) {
    format = formatOverride as ReportFormat;
  } else if (formatOverride && formatOverride !== 'auto') {
    throw new ReportParseError(`invalid REPORT_FORMAT "${formatOverride}"`);
  } else if (ext === '.xml') {
    format = ReportFormat.JUNIT_XML;
  } else {
    format = detectJsonFormat(content);
  }

  switch (format) {
    case ReportFormat.JUNIT_XML:
      return parseJUnitXml(content);

    case ReportFormat.PYTEST_JSON: {
      let raw: unknown;
      try { raw = JSON.parse(content); } catch {
        throw new ReportParseError(`invalid JSON in pytest report ${reportPath}`);
      }
      return parsePytestJson(raw as Record<string, unknown>);
    }

    case ReportFormat.PLAYWRIGHT_JSON:
    case ReportFormat.PLAYWRIGHT_API: {
      let raw: unknown;
      try { raw = JSON.parse(content); } catch {
        // Non-JSON with .json extension — try XML fallback
        return tryXmlFallback(content, reportPath);
      }
      return parsePlaywrightJson(raw as Record<string, unknown>, format);
    }

    default: {
      // UNKNOWN — content was not valid JSON; attempt XML
      return tryXmlFallback(content, reportPath);
    }
  }
}

// Defensive bounds for `findCandidateReportFiles`. A misconfigured artifact
// (e.g. one that included `node_modules` or a build output by mistake) can
// otherwise turn the recursive scan into a multi-second walk over tens of
// thousands of files, each of which is then read + JSON.parse'd. All caps
// are tunable via env vars for the rare case that someone genuinely needs
// deeper nesting, more files, or a wider scan. Caps are read at scan time
// (not at module load) so tests can override them per-case.
function readPositiveIntEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

interface ScanCaps {
  maxDepth:          number;
  maxCandidateFiles: number;
  // Hard upper bound on the total number of directory entries inspected
  // (files + subdirs, regardless of extension). Without this, a wide tree
  // of mostly non-report files — say a checked-in `.next/` of a few
  // thousand chunked HTML/CSS files plus a single test report — is still
  // walked in full because the candidate cap (which only counts
  // .json/.xml) never fires. 50k is generous for legitimate test
  // artifacts and tight enough to bound the worst case to under a second.
  maxVisitedEntries: number;
}

function readScanCaps(): ScanCaps {
  return {
    maxDepth:          readPositiveIntEnv('ORACLE_MAX_REPORT_SCAN_DEPTH',      10),
    maxCandidateFiles: readPositiveIntEnv('ORACLE_MAX_REPORT_CANDIDATES',     500),
    maxVisitedEntries: readPositiveIntEnv('ORACLE_MAX_REPORT_VISITED_ENTRIES', 50_000),
  };
}

// Directories we never descend into. Test reports never live here, and these
// directories are common sources of `.json` decoys (package manifests,
// coverage data, source-control metadata) or massive non-report file trees
// (build outputs, framework caches).
const SKIP_DIR_NAMES = new Set([
  // Source-control metadata
  '.git', '.svn', '.hg',
  // Package management / module trees
  'node_modules',
  // Coverage / cache
  'coverage', '.nyc_output', '.cache',
  // Common build outputs (often contain stray .json files like
  // chunk manifests or sourcemaps that decoy as Playwright reports)
  'dist', 'build', 'out', 'target',
  // Framework outputs and tool caches
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.vite', '.parcel-cache',
]);

/**
 * Walk a directory tree to collect candidate report files (.json / .xml).
 *
 * Returns the discovered file list plus a non-null `truncatedReason` if any
 * scan cap pruned the walk. The walker itself never throws — pruning is a
 * recoverable signal that callers may handle (e.g. by widening the cap or
 * narrowing the scan path). `parseReportDirectory()` treats truncation as
 * fail-closed so a partial file list cannot be silently parsed into a
 * misleading "no failures found" verdict.
 */
interface ScanResult {
  files:           string[];
  /** Human-readable reason describing which cap fired, or null if complete. */
  truncatedReason: string | null;
}

function findCandidateReportFiles(dir: string): ScanResult {
  const out: string[] = [];
  const state = {
    visited:         0,
    truncatedReason: null as string | null,
  };
  const caps = readScanCaps();
  walk(dir, 0, out, state, caps);
  return { files: out.sort(), truncatedReason: state.truncatedReason };
}

function walk(
  dir:    string,
  depth:  number,
  out:    string[],
  state:  { visited: number; truncatedReason: string | null },
  caps:   ScanCaps,
): void {
  // If a cap already tripped in a sibling branch, stop without inspecting
  // further entries — the result will be discarded by parseReportDirectory.
  if (state.truncatedReason !== null) return;

  if (depth > caps.maxDepth) {
    state.truncatedReason =
      `ORACLE_MAX_REPORT_SCAN_DEPTH=${caps.maxDepth} (depth cap hit at ${dir})`;
    console.warn(`[oracle] report scan depth cap (${caps.maxDepth}) hit at ${dir} — pruning`);
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    state.visited++;
    if (state.visited > caps.maxVisitedEntries) {
      state.truncatedReason =
        `ORACLE_MAX_REPORT_VISITED_ENTRIES=${caps.maxVisitedEntries} (visited-entry cap hit while scanning ${dir})`;
      console.warn(
        `[oracle] report visited-entry cap (${caps.maxVisitedEntries}) hit while scanning ${dir} — pruning. ` +
        `Set ORACLE_MAX_REPORT_VISITED_ENTRIES to override.`,
      );
      return;
    }
    if (out.length >= caps.maxCandidateFiles) {
      state.truncatedReason =
        `ORACLE_MAX_REPORT_CANDIDATES=${caps.maxCandidateFiles} (candidate cap hit while scanning ${dir})`;
      console.warn(`[oracle] report candidate cap (${caps.maxCandidateFiles}) hit while scanning ${dir} — pruning`);
      return;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walk(fullPath, depth + 1, out, state, caps);
      // After the recursive call, the child may have set truncatedReason.
      // Stop iterating siblings so we don't keep accumulating partial
      // candidates after a cap has already fired.
      if (state.truncatedReason !== null) return;
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (ext === '.json' || ext === '.xml') out.push(fullPath);
  }
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

function isValidFormat(val: string): boolean {
  return (Object.values(ReportFormat) as string[]).includes(val);
}

function detectJsonFormat(content: string): ReportFormat {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return ReportFormat.UNKNOWN; }

  if (typeof raw !== 'object' || raw === null) return ReportFormat.UNKNOWN;
  const r = raw as Record<string, unknown>;

  if ('suites' in r) return ReportFormat.PLAYWRIGHT_JSON;

  if (Array.isArray(r['tests'])) {
    const first = (r['tests'] as unknown[])[0];
    if (first && typeof first === 'object' && 'nodeid' in (first as object)) {
      return ReportFormat.PYTEST_JSON;
    }
  }

  return ReportFormat.UNKNOWN;
}

function tryXmlFallback(content: string, reportPath: string): ParseResult {
  try {
    return parseJUnitXml(content);
  } catch (err) {
    throw new ReportParseError(`could not parse report ${reportPath} in any known format: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Playwright JSON parser
// ---------------------------------------------------------------------------

interface Suite {
  title:   string;
  specs?:  Spec[];
  suites?: Suite[];
}

interface Spec {
  title:  string;
  file?:  string;
  tests?: Test[];
}

interface Test {
  results?: TestResult[];
}

interface TestResult {
  status:    string;
  retry?:    number;
  duration?: number;
  errors?:   Array<{ message?: string }>;
}

function parsePlaywrightJson(
  raw: Record<string, unknown>,
  format: ReportFormat,
): ParseResult {
  if (!Array.isArray(raw['suites'])) {
    throw new ReportParseError('Playwright report missing "suites" array');
  }

  const failures: PlaywrightFailure[] = [];
  let totalTests = 0;

  for (const suite of raw['suites']) {
    collectFailures(suite as Suite, failures);
    totalTests += countTests(suite as Suite);
  }

  return { failures, detectedFormat: format, totalTests, totalFailures: failures.length };
}

function collectFailures(suite: Suite, acc: PlaywrightFailure[]): void {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      for (const result of test.results ?? []) {
        if (result.status === 'failed' || result.status === 'timedOut') {
          const errorMessage = result.errors?.map(e => e.message ?? '').join('\n') ?? '';
          acc.push({
            testName:     `${suite.title} > ${spec.title}`,
            errorMessage,
            errorHash:    hashError(errorMessage),
            file:         spec.file ?? '',
            duration:     result.duration ?? 0,
            retries:      result.retry ?? 0,
          });
        }
      }
    }
  }
  for (const child of suite.suites ?? []) {
    collectFailures(child, acc);
  }
}

function countTests(suite: Suite): number {
  let count = 0;
  for (const spec of suite.specs ?? []) {
    count += (spec.tests ?? []).length;
  }
  for (const child of suite.suites ?? []) {
    count += countTests(child);
  }
  return count;
}

// ---------------------------------------------------------------------------
// JUnit XML parser
// ---------------------------------------------------------------------------

interface JUnitFailureElement {
  '@_message'?: string;
  '@_type'?:    string;
  '#text'?:     string | number;
}

interface JUnitTestCase {
  '@_name'?:      string;
  '@_classname'?: string;
  '@_time'?:      string | number;
  failure?: JUnitFailureElement | JUnitFailureElement[];
  error?:   JUnitFailureElement | JUnitFailureElement[];
}

interface JUnitTestSuite {
  '@_name'?:  string;
  '@_tests'?: string | number;
  testcase?:  JUnitTestCase | JUnitTestCase[];
}

interface JUnitTestSuites {
  testsuite?: JUnitTestSuite | JUnitTestSuite[];
}

function parseJUnitXml(content: string): ParseResult {
  const parser = new XMLParser({
    ignoreAttributes:    false,
    attributeNamePrefix: '@_',
    textNodeName:        '#text',
    isArray: (tagName: string) => tagName === 'testsuite' || tagName === 'testcase',
    // Large JUnit reports (300+ tests with HTML-encoded names like &gt;/&amp;) can
    // exceed fast-xml-parser's default entity expansion limit of 1000.
    // maxTotalExpansions lives inside the processEntities config object.
    processEntities: {
      enabled:            true,
      maxTotalExpansions: 100_000,
      maxExpandedLength:  10_000_000,
    } as unknown as boolean,
  });

  let raw: Record<string, unknown>;
  try {
    raw = parser.parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new ReportParseError(`failed to parse JUnit XML: ${(err as Error).message}`);
  }

  // Handle both <testsuites> wrapper and bare <testsuite> at root.
  // Note: fast-xml-parser's isArray forces 'testsuite' to always be an array,
  // so raw['testsuite'] is JUnitTestSuite[] — use toArray() to handle both cases.
  const rootSuites = raw['testsuites'] as JUnitTestSuites | undefined;

  const suites: JUnitTestSuite[] = rootSuites
    ? toArray(rootSuites.testsuite)
    : toArray(raw['testsuite'] as JUnitTestSuite | JUnitTestSuite[] | undefined);

  if (suites.length === 0) {
    throw new ReportParseError('JUnit XML report contains no testsuite elements');
  }

  const failures: PlaywrightFailure[] = [];
  let totalTests = 0;

  for (const suite of suites) {
    const suiteName = String(suite['@_name'] ?? '');
    for (const tc of toArray(suite.testcase)) {
      totalTests++;
      const tcName    = String(tc['@_name']      ?? '');
      const className = String(tc['@_classname'] ?? '');
      const timeRaw   = parseFloat(String(tc['@_time'] ?? '0'));
      const duration  = isNaN(timeRaw) ? 0 : timeRaw * 1000;

      const testName = suiteName
        ? `${suiteName} > ${tcName}`
        : `${className} > ${tcName}`;

      const failElems = [
        ...toArray(tc.failure),
        ...toArray(tc.error),
      ];

      for (const elem of failElems) {
        const msg        = String(elem['@_message'] ?? '');
        const stackTrace = String(elem['#text'] ?? '').trim().slice(0, 1000);
        const errorMessage = stackTrace ? `${msg}\n${stackTrace}` : msg;

        failures.push({
          testName,
          errorMessage,
          errorHash: hashError(errorMessage),
          file:      classNameToFile(className),
          duration,
          retries:   0,
        });
      }
    }
  }

  return { failures, detectedFormat: ReportFormat.JUNIT_XML, totalTests, totalFailures: failures.length };
}

function classNameToFile(className: string): string {
  if (!className) return '';
  if (className.includes('/'))  return className;                           // already path-like
  if (className.includes('.'))  return className.replace(/\./g, '/') + '.java'; // Java-style
  return className;
}

// ---------------------------------------------------------------------------
// pytest JSON parser
// ---------------------------------------------------------------------------

interface PytestTest {
  nodeid?:   string;
  outcome?:  string;
  duration?: number;
  call?: {
    longrepr?: string;
  };
}

function parsePytestJson(raw: Record<string, unknown>): ParseResult {
  const tests = raw['tests'];
  if (!Array.isArray(tests)) {
    throw new ReportParseError('pytest JSON report missing "tests" array');
  }

  const failures: PlaywrightFailure[] = [];
  const totalTests = tests.length;

  for (const item of tests) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as PytestTest;

    const outcome = t.outcome ?? '';
    if (outcome !== 'failed' && outcome !== 'error') continue;

    const nodeid      = t.nodeid ?? '';
    const duration    = (typeof t.duration === 'number' ? t.duration : 0) * 1000;
    const longrepr    = String(t.call?.longrepr ?? '').slice(0, 1000);

    failures.push({
      testName:     nodeidToTestName(nodeid),
      errorMessage: longrepr,
      errorHash:    hashError(longrepr),
      file:         nodeidToFile(nodeid),
      duration,
      retries:      0,
    });
  }

  return { failures, detectedFormat: ReportFormat.PYTEST_JSON, totalTests, totalFailures: failures.length };
}

function nodeidToTestName(nodeid: string): string {
  const parts = nodeid.split('::');
  if (parts.length >= 2) return parts.slice(-2).join(' > ');
  return nodeid;
}

function nodeidToFile(nodeid: string): string {
  const idx = nodeid.indexOf('::');
  return idx >= 0 ? nodeid.slice(0, idx) : nodeid;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function hashError(message: string): string {
  return createHash('sha256').update(message).digest('hex').slice(0, 12);
}

function toArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}
