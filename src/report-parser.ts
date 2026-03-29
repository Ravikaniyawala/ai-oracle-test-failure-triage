import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { extname } from 'path';
import { XMLParser } from 'fast-xml-parser';
import { type PlaywrightFailure, ReportFormat, type ParseResult } from './types.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function parseReport(reportPath: string): ParseResult {
  let content: string;
  try {
    content = readFileSync(reportPath, 'utf8');
  } catch {
    console.warn(`[oracle] could not read report at ${reportPath}`);
    return emptyResult(ReportFormat.UNKNOWN);
  }

  const formatOverride = process.env['REPORT_FORMAT'];
  const ext = extname(reportPath).toLowerCase();

  let format: ReportFormat;
  if (formatOverride && isValidFormat(formatOverride)) {
    format = formatOverride as ReportFormat;
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
        console.warn('[oracle] invalid JSON in pytest report');
        return emptyResult(ReportFormat.PYTEST_JSON);
      }
      return parsePytestJson(raw as Record<string, unknown>);
    }

    case ReportFormat.PLAYWRIGHT_JSON:
    case ReportFormat.PLAYWRIGHT_API: {
      let raw: unknown;
      try { raw = JSON.parse(content); } catch {
        // Non-JSON with .json extension — try XML fallback
        return tryXmlFallback(content);
      }
      return parsePlaywrightJson(raw as Record<string, unknown>, format);
    }

    default: {
      // UNKNOWN — content was not valid JSON; attempt XML
      return tryXmlFallback(content);
    }
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

function tryXmlFallback(content: string): ParseResult {
  try {
    return parseJUnitXml(content);
  } catch {
    console.warn('[oracle] could not parse report in any known format');
    return emptyResult(ReportFormat.UNKNOWN);
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
  const failures: PlaywrightFailure[] = [];
  let totalTests = 0;

  for (const suite of (raw['suites'] as unknown[] | undefined) ?? []) {
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
  });

  let raw: Record<string, unknown>;
  try {
    raw = parser.parse(content) as Record<string, unknown>;
  } catch (err) {
    console.warn('[oracle] failed to parse JUnit XML:', (err as Error).message);
    return emptyResult(ReportFormat.JUNIT_XML);
  }

  // Handle both <testsuites> wrapper and bare <testsuite> at root
  const rootSuites = raw['testsuites'] as JUnitTestSuites | undefined;
  const rootSuite  = raw['testsuite']  as JUnitTestSuite  | undefined;

  const suites: JUnitTestSuite[] = rootSuites
    ? toArray(rootSuites.testsuite)
    : rootSuite ? [rootSuite] : [];

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
  if (!Array.isArray(tests)) return emptyResult(ReportFormat.PYTEST_JSON);

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

function emptyResult(format: ReportFormat): ParseResult {
  return { failures: [], detectedFormat: format, totalTests: 0, totalFailures: 0 };
}
